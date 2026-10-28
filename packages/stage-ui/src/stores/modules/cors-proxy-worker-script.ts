/**
 * Minimal standalone Web CORS Reverse-Proxy & Companion Embassy Worker source.
 *
 * Uploaded as `airi-cors-proxy` and `airi-stage-edge` when deploying from web/mobile,
 * where there is no bundler (esbuild) or Electron IPC to ship the full stage-edge worker.
 * Route parity with the proxy and companion embassy subsets of `apps/stage-edge/src/index.ts`:
 * - OPTIONS preflight
 * - GET /health
 * - /cors-proxy + /proxy forwarding with Access-Control-Allow-Origin: *
 * - GET /api/companion/card for friend discovery
 * - GET /ws hibernated socket attach (owner-gated, DO only)
 * - POST /api/friends/request for cross-account pairing (Ed25519-verified)
 * - POST /api/friends/invite for invite code issuance (owner-gated)
 * - POST /api/friends/accept for trust grants (owner-gated)
 * - POST /api/friends/inbox for nap-chat turn relay (Ed25519-verified, trust-gated)
 * - GET /api/friends/requests for owner-side pending review (owner-gated, on-demand only — never polled)
 *
 * No external imports — a single self-contained ES module. Requires MEMORY KV
 * and OWNER_ID bindings in production; degrades to explicit 503s without them.
 * Security posture mirrors apps/stage-edge/src/index.ts exactly: verify-first
 * (signature before trust), fail-closed on every malformed or unauthenticated
 * call. Any divergence between the two is a bug — see
 * cors-proxy-worker-script.test.ts, which locks the parity.
 */

// NOTICE: plain string concatenation inside the worker source (no backticks or
// ${} interpolations) so this outer template literal needs no escaping.
export const CORS_PROXY_WORKER_SCRIPT = `function hexToPeerBytes(hex) {
  if (!hex) return new Uint8Array();
  var matches = String(hex).match(/.{1,2}/g);
  if (!matches) return new Uint8Array();
  return new Uint8Array(matches.map(function(byte) { return Number.parseInt(byte, 16); }));
}
function sanitizeIntroMessage(input) {
  var text = typeof input === 'string' ? input : '';
  return text.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim().slice(0, 100);
}
function sanitizeTaglineMessage(input) {
  var text = typeof input === 'string' ? input : '';
  return text.replace(/<[^>]*>/g, '').replace(/[<>]/g, '').trim().slice(0, 140);
}
function isHex64Peer(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}
function isFreshPeerTimestamp(timestamp) {
  if (typeof timestamp !== 'number' || !isFinite(timestamp)) return false;
  return Math.abs(Date.now() - timestamp) <= 300 * 1000;
}
async function verifyPeerSignature(publicKeyHex, signatureHex, message) {
  try {
    var encoder = new TextEncoder();
    var data = encoder.encode(message);
    var key = await crypto.subtle.importKey('raw', hexToPeerBytes(publicKeyHex).buffer, 'Ed25519', false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, hexToPeerBytes(signatureHex).buffer, data.buffer);
  } catch (e) {
    return false;
  }
}
async function consumePeerNonce(env, nonce) {
  if (!env || !env.MEMORY || !nonce || nonce.length < 8 || nonce.length > 128) return false;
  try {
    var seen = await env.MEMORY.get('friends/nonces/' + nonce);
    if (seen) return false;
    await env.MEMORY.put('friends/nonces/' + nonce, '1', { expirationTtl: 600 });
    return true;
  } catch (e) {
    return false;
  }
}
export default {
  async fetch(request, env) {
    var url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    if (url.pathname === '/health') {
      return corsJson({ status: 'ok', worker: 'airi-cors-proxy', stageEdge: true }, 200);
    }

    if (url.pathname === '/ws') {
      var wsOwner = request.headers.get('x-owner-id') || url.searchParams.get('owner');
      if (!env || !env.OWNER_ID || !wsOwner || wsOwner !== env.OWNER_ID) {
        return corsJson({ error: 'forbidden' }, 403);
      }
      if (!env.EMBASSY) {
        return corsJson({ error: 'embassy_not_configured' }, 503);
      }
      var stub = env.EMBASSY.get(env.EMBASSY.idFromName('embassy'));
      return stub.fetch(request);
    }

    if (url.pathname === '/api/companion/card') {
      return corsJson({
        name: (env && env.CHARACTER_NAME) || 'AIRI',
        avatarUrl: null,
        tagline: (env && env.COMPANION_TAGLINE) || 'Personal Edge Companion',
        publicKey: null
      }, 200);
    }

    if (url.pathname === '/api/friends/request') {
      if (!env || !env.MEMORY) {
        return corsJson({ error: 'kv_not_configured' }, 503);
      }
      var reqBody = null;
      try {
        reqBody = await request.json();
      } catch (e) {
        return corsJson({ error: 'invalid_json' }, 400);
      }
      var reqIntro = sanitizeIntroMessage(reqBody && reqBody.introMessage);
      if (reqBody && typeof reqBody.introMessage === 'string' && reqBody.introMessage.length > 100) {
        return corsJson({ error: 'intro_too_long' }, 400);
      }
      var reqTagline = sanitizeTaglineMessage(reqBody && reqBody.fromTagline);
      if (reqBody && typeof reqBody.fromTagline === 'string' && reqBody.fromTagline.length > 140) {
        return corsJson({ error: 'tagline_too_long' }, 400);
      }
      if (!reqBody || typeof reqBody.fromHandle !== 'string' || !reqBody.fromHandle
        || !isHex64Peer(reqBody.fromPubkey) || typeof reqBody.fromCharacterName !== 'string' || !reqBody.fromCharacterName) {
        return corsJson({ error: 'invalid_identity' }, 400);
      }
      if (!isFreshPeerTimestamp(reqBody.timestamp) || typeof reqBody.nonce !== 'string') {
        return corsJson({ error: 'stale_or_missing_timestamp' }, 400);
      }
      if (typeof reqBody.signature !== 'string' || !reqBody.signature) {
        return corsJson({ error: 'missing_signature' }, 401);
      }
      if (reqBody.invite !== undefined) {
        if (typeof reqBody.invite !== 'string' || !reqBody.invite) {
          return corsJson({ error: 'invalid_invite' }, 400);
        }
        var invStored = null;
        try {
          invStored = await env.MEMORY.get('friends/invites/' + reqBody.invite);
        } catch (e) {}
        if (!invStored) {
          return corsJson({ error: 'invalid_invite' }, 400);
        }
      }
      if (!await consumePeerNonce(env, reqBody.nonce)) {
        return corsJson({ error: 'replayed_nonce' }, 400);
      }
      var reqSigOk = await verifyPeerSignature(
        reqBody.fromPubkey, reqBody.signature,
        reqBody.timestamp + ':' + reqBody.nonce + ':' + reqIntro + ':' + reqBody.fromPubkey
      );
      if (!reqSigOk) {
        return corsJson({ error: 'invalid_signature' }, 401);
      }
      var reqId = 'cf_req_' + Date.now().toString(36);
      var record = {
        id: reqId,
        fromHandle: reqBody.fromHandle,
        fromPubkey: reqBody.fromPubkey,
        fromCharacterName: reqBody.fromCharacterName,
        introMessage: reqIntro,
        fromTagline: reqTagline,
        timestamp: reqBody.timestamp,
        nonce: reqBody.nonce,
        status: 'pending'
      };

      if (env.EMBASSY) {
        try {
          var embassyStub = env.EMBASSY.get(env.EMBASSY.idFromName('embassy'));
          var doRes = await embassyStub.fetch('http://do/internal/friend-request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record)
          });
          var doData = {};
          try {
            doData = await doRes.json();
          } catch (e) {}
          if (!doRes.ok) {
            var doStatus = doRes.status === 400 ? 400 : 502;
            var doBody = (doData && doData.error) ? doData : { error: 'embassy_unreachable' };
            return corsJson(doBody, doStatus);
          }
          return corsJson({ status: 'pending', id: reqId, pushed: doData.pushed || 0 }, 200);
        } catch (e) {
          return corsJson({ error: 'embassy_unreachable' }, 502);
        }
      }

      try {
        await env.MEMORY.put('friends/requests/inbound/' + reqId, JSON.stringify(record));
      } catch (e) {
        return corsJson({ error: 'kv_write_failed' }, 503);
      }
      return corsJson({ status: 'pending', id: reqId }, 200);
    }

    if (url.pathname === '/api/friends/accept') {
      if (!env || !env.MEMORY) {
        return corsJson({ error: 'kv_not_configured' }, 503);
      }
      var acceptOwner = request.headers.get('x-owner-id');
      if (!env.OWNER_ID || !acceptOwner || acceptOwner !== env.OWNER_ID) {
        return corsJson({ error: 'forbidden' }, 403);
      }
      try {
        var acceptBody = await request.clone().json();
        if (acceptBody && acceptBody.pubkey) {
          if (env.EMBASSY) {
            var acceptStub = env.EMBASSY.get(env.EMBASSY.idFromName('embassy'));
            await acceptStub.fetch('http://do/internal/accept', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pubkey: acceptBody.pubkey, handle: acceptBody.handle || '' })
            }).catch(function() {});
          }
          await env.MEMORY.put('friends/accepted/' + acceptBody.pubkey, JSON.stringify({
            handle: acceptBody.handle || '',
            acceptedAt: Date.now()
          }));
          return corsJson({ trusted: true }, 200);
        }
      } catch (e) {}
      return corsJson({ error: 'invalid_identity' }, 400);
    }

    if (url.pathname === '/internal/pending' || url.pathname === '/api/friends/requests') {
      if (!env || !env.MEMORY) {
        return corsJson({ requests: [] }, 200);
      }
      var pendingOwner = request.headers.get('x-owner-id') || url.searchParams.get('owner');
      if (!env.OWNER_ID || !pendingOwner || pendingOwner !== env.OWNER_ID) {
        return corsJson({ error: 'forbidden' }, 403);
      }
      if (env.EMBASSY) {
        try {
          var pendingStub = env.EMBASSY.get(env.EMBASSY.idFromName('embassy'));
          var pendingRes = await pendingStub.fetch('http://do/internal/pending');
          return corsJson(await pendingRes.json(), 200);
        } catch (e) {}
      }
      try {
        var list = await env.MEMORY.list({ prefix: 'friends/requests/inbound/' });
        var reqs = [];
        for (var k of list.keys) {
          var val = await env.MEMORY.get(k.name);
          if (val) {
            var item = JSON.parse(val);
            if (item && item.status === 'pending') {
              reqs.push(item);
            }
          }
        }
        return corsJson({ requests: reqs }, 200);
      } catch (e) {
        return corsJson({ requests: [] }, 200);
      }
    }

    if (url.pathname === '/api/friends/invite') {
      if (!env || !env.MEMORY) {
        return corsJson({ error: 'kv_not_configured' }, 503);
      }
      var inviteOwner = request.headers.get('x-owner-id');
      if (!env.OWNER_ID || !inviteOwner || inviteOwner !== env.OWNER_ID) {
        return corsJson({ error: 'forbidden' }, 403);
      }
      var invCode = 'cf_inv_' + Date.now().toString(36);
      try {
        await env.MEMORY.put('friends/invites/' + invCode, JSON.stringify({ createdAt: Date.now() }), { expirationTtl: 86400 });
      } catch (e) {
        return corsJson({ error: 'kv_write_failed' }, 503);
      }
      var origin = new URL(request.url).origin;
      return corsJson({ invite: invCode, uri: 'airi://pair?worker=' + origin + '&invite=' + invCode, expiresAt: Date.now() + 86400000 }, 200);
    }

    if (url.pathname === '/api/friends/inbox') {
      if (!env || !env.MEMORY) {
        return corsJson({ error: 'kv_not_configured' }, 503);
      }
      var senderPubkey = request.headers.get('x-sender-pubkey');
      var inboxSig = request.headers.get('x-signature-ed25519');
      var inboxTsHeader = request.headers.get('x-signature-timestamp');
      var inboxNonce = request.headers.get('x-signature-nonce');
      var inboxTs = inboxTsHeader ? Number(inboxTsHeader) : NaN;
      if (!isHex64Peer(senderPubkey) || !inboxSig || !isFreshPeerTimestamp(inboxTs) || !inboxNonce) {
        return corsJson({ error: 'unauthorized' }, 401);
      }
      var inboxBody = await request.text();
      if (!await consumePeerNonce(env, inboxNonce)) {
        return corsJson({ error: 'replayed_nonce' }, 400);
      }
      var inboxSigOk = await verifyPeerSignature(senderPubkey, inboxSig, inboxTs + ':' + inboxNonce + ':' + inboxBody);
      if (!inboxSigOk) {
        return corsJson({ error: 'invalid_signature' }, 401);
      }
      if (env.EMBASSY) {
        var inboxTopic = 'unknown';
        try {
          var inboxParsed = JSON.parse(inboxBody);
          if (inboxParsed && typeof inboxParsed.topic === 'string' && inboxParsed.topic) {
            inboxTopic = inboxParsed.topic;
          }
        } catch (e) {}
        try {
          var inboxStub = env.EMBASSY.get(env.EMBASSY.idFromName('embassy'));
          var inboxRes = await inboxStub.fetch('http://do/internal/inbox', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              senderPubkey: senderPubkey,
              topic: inboxTopic,
              payloadJson: inboxBody,
              timestamp: inboxTs,
              nonce: inboxNonce
            })
          });
          var inboxData = {};
          try {
            inboxData = await inboxRes.json();
          } catch (e) {}
          if (!inboxRes.ok) {
            if (inboxRes.status === 403) {
              return corsJson({ error: 'quarantined' }, 403);
            }
            return corsJson((inboxData && inboxData.error) ? inboxData : { error: 'embassy_unreachable' }, 502);
          }
          return corsJson({ queued: true, pushed: inboxData.pushed || 0 }, 200);
        } catch (e) {
          return corsJson({ error: 'embassy_unreachable' }, 502);
        }
      }
      var inboxAccepted = null;
      try {
        inboxAccepted = await env.MEMORY.get('friends/accepted/' + senderPubkey);
      } catch (e) {}
      if (!inboxAccepted) {
        return corsJson({ error: 'quarantined' }, 403);
      }
      try {
        await env.MEMORY.put('friends/inbox/' + senderPubkey + '/' + inboxTs + '_' + inboxNonce, inboxBody);
      } catch (e) {
        return corsJson({ error: 'kv_write_failed' }, 503);
      }
      return corsJson({ queued: true }, 200);
    }

    if (url.pathname === '/cors-proxy' || url.pathname === '/proxy') {
      var targetUrl = url.searchParams.get('url') || request.headers.get('x-target-url');
      if (!targetUrl) {
        return corsJson({ error: 'Missing target URL parameter. Example: /cors-proxy?url=https://api.cloudflare.com/client/v4/user' }, 400);
      }
      try {
        var parsedTarget = new URL(targetUrl);
        var forwardHeaders = new Headers(request.headers);
        forwardHeaders.delete('host');
        forwardHeaders.delete('referer');
        forwardHeaders.delete('origin');
        forwardHeaders.delete('x-target-url');
        var customAuth = request.headers.get('x-target-authorization');
        if (customAuth) {
          forwardHeaders.set('Authorization', customAuth);
          forwardHeaders.delete('x-target-authorization');
        }
        var upstreamRes = await fetch(parsedTarget.toString(), {
          method: request.method,
          headers: forwardHeaders,
          body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : undefined,
          redirect: 'follow'
        });
        var responseHeaders = new Headers(upstreamRes.headers);
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
        responseHeaders.set('Access-Control-Allow-Headers', '*');
        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          statusText: upstreamRes.statusText,
          headers: responseHeaders
        });
      } catch (err) {
        return corsJson({ error: 'Upstream fetch failed: ' + (err && err.message ? err.message : String(err)) }, 502);
      }
    }

    return corsJson({ error: 'Not found' }, 404);
  }
};

function corsJson(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

export class EmbassyDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    var url = new URL(request.url);

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected websocket', { status: 426, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
      }
      var ownerId = request.headers.get('x-owner-id') || url.searchParams.get('owner');
      if (!this.env.OWNER_ID || !ownerId || ownerId !== this.env.OWNER_ID) {
        return new Response('Forbidden', { status: 403, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' } });
      }
      var machineId = url.searchParams.get('machine') || 'unknown-device';
      var pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1], [machineId]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (request.method === 'POST' && url.pathname === '/internal/friend-request') {
      var record = null;
      try {
        record = await request.json();
      } catch (e) {
        return Response.json({ error: 'invalid_json' }, { status: 400 });
      }
      if (!record || !record.id || !record.fromHandle || !record.fromPubkey) {
        return Response.json({ error: 'invalid_identity' }, { status: 400 });
      }
      await this.state.blockConcurrencyWhile(async () => {
        this.ensureSchema();
        var existing = this.state.storage.sql.exec(
          'SELECT id FROM friend_requests WHERE nonce = ? LIMIT 1',
          record.nonce || record.id
        ).toArray();
        if (existing.length === 0) {
          this.state.storage.sql.exec(
            'INSERT INTO friend_requests (id, from_handle, from_pubkey, from_character_name, intro_message, from_tagline, timestamp, nonce, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            record.id,
            record.fromHandle,
            record.fromPubkey,
            record.fromCharacterName || 'AIRI',
            record.introMessage || '',
            record.fromTagline || '',
            Number(record.timestamp || Date.now()),
            record.nonce || record.id,
            'pending',
            Date.now()
          );
        }
      });
      var pushed = this.pushToSockets({ type: 'inbound_request', request: record });
      return Response.json({ stored: true, pushed: pushed });
    }

    if (request.method === 'POST' && url.pathname === '/internal/accept') {
      var body = null;
      try {
        body = await request.json();
      } catch (e) {
        return Response.json({ error: 'invalid_json' }, { status: 400 });
      }
      if (!body || !body.pubkey) {
        return Response.json({ error: 'invalid_identity' }, { status: 400 });
      }
      await this.state.blockConcurrencyWhile(async () => {
        this.ensureSchema();
        this.state.storage.sql.exec(
          'INSERT OR REPLACE INTO trusted_peers (pubkey, handle, accepted_at) VALUES (?, ?, ?)',
          body.pubkey,
          body.handle || '',
          Date.now()
        );
        this.state.storage.sql.exec(
          "UPDATE friend_requests SET status = 'trusted' WHERE from_pubkey = ? AND status = 'pending'",
          body.pubkey
        );
      });
      return Response.json({ trusted: true });
    }

    if (request.method === 'POST' && url.pathname === '/internal/inbox') {
      var inTurn = null;
      try {
        inTurn = await request.json();
      } catch (e) {
        return Response.json({ error: 'invalid_turn' }, { status: 400 });
      }
      if (!inTurn || typeof inTurn.senderPubkey !== 'string' || typeof inTurn.topic !== 'string' || typeof inTurn.payloadJson !== 'string') {
        return Response.json({ error: 'invalid_turn' }, { status: 400 });
      }
      var inTrusted = false;
      await this.state.blockConcurrencyWhile(async () => {
        this.ensureSchema();
        var inRows = this.state.storage.sql.exec(
          'SELECT pubkey FROM trusted_peers WHERE pubkey = ? LIMIT 1', inTurn.senderPubkey
        ).toArray();
        inTrusted = inRows.length > 0;
        if (!inTrusted) return;
        this.state.storage.sql.exec(
          'INSERT OR IGNORE INTO nap_turns (id, sender_pubkey, topic, payload_json, timestamp) VALUES (?, ?, ?, ?, ?)',
          inTurn.timestamp + '_' + (inTurn.nonce || 'x'), inTurn.senderPubkey, inTurn.topic, inTurn.payloadJson, Number(inTurn.timestamp)
        );
      });
      if (!inTrusted) {
        return Response.json({ error: 'quarantined' }, { status: 403 });
      }
      var inPushed = this.pushToSockets({
        type: 'nap_turn',
        turn: {
          id: '' + inTurn.timestamp, senderPubkey: inTurn.senderPubkey, topic: inTurn.topic,
          payloadJson: inTurn.payloadJson, timestamp: Number(inTurn.timestamp)
        }
      });
      return Response.json({ queued: true, pushed: inPushed });
    }

    if (request.method === 'GET' && url.pathname === '/internal/pending') {
      var requests = [];
      await this.state.blockConcurrencyWhile(async () => {
        this.ensureSchema();
        requests = this.listPending();
      });
      return Response.json({ requests: requests });
    }

    return new Response('Not Found', { status: 404 });
  }

  ensureSchema() {
    this.state.storage.sql.exec('CREATE TABLE IF NOT EXISTS friend_requests (id TEXT PRIMARY KEY, from_handle TEXT NOT NULL, from_pubkey TEXT NOT NULL, from_character_name TEXT NOT NULL, intro_message TEXT NOT NULL DEFAULT "", from_tagline TEXT NOT NULL DEFAULT "", timestamp INTEGER NOT NULL, nonce TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT "pending", created_at INTEGER NOT NULL)');
    try {
      this.state.storage.sql.exec('ALTER TABLE friend_requests ADD COLUMN from_tagline TEXT NOT NULL DEFAULT ""');
    } catch (e) {}
    this.state.storage.sql.exec('CREATE TABLE IF NOT EXISTS trusted_peers (pubkey TEXT PRIMARY KEY, handle TEXT NOT NULL, accepted_at INTEGER NOT NULL)');
    this.state.storage.sql.exec('CREATE TABLE IF NOT EXISTS nap_turns (id TEXT PRIMARY KEY, sender_pubkey TEXT NOT NULL, topic TEXT NOT NULL, payload_json TEXT NOT NULL, timestamp INTEGER NOT NULL)');
  }

  listPending() {
    var rows = this.state.storage.sql.exec(
      "SELECT id, from_handle, from_pubkey, from_character_name, intro_message, from_tagline, timestamp, nonce FROM friend_requests WHERE status = 'pending' ORDER BY created_at ASC LIMIT 100"
    ).toArray();
    return rows.map(function(row) {
      return {
        id: String(row.id),
        fromHandle: String(row.from_handle),
        fromPubkey: String(row.from_pubkey),
        fromCharacterName: String(row.from_character_name),
        introMessage: String(row.intro_message || ''),
        fromTagline: String(row.from_tagline || ''),
        timestamp: Number(row.timestamp),
        nonce: String(row.nonce)
      };
    });
  }

  pushToSockets(event) {
    var text = JSON.stringify(event);
    var count = 0;
    for (var ws of this.state.getWebSockets()) {
      try {
        ws.send(text);
        count++;
      } catch (e) {}
    }
    return count;
  }

  async webSocketMessage(ws, message) {
    var action = null;
    try {
      action = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch (e) {}
    if (!action || action.action !== 'sync') return;
    var requests = [];
    await this.state.blockConcurrencyWhile(async () => {
      this.ensureSchema();
      requests = this.listPending();
    });
    try {
      ws.send(JSON.stringify({ type: 'pending_sync', requests: requests }));
    } catch (e) {}
  }

  async webSocketClose() {}
  async webSocketError(ws) {
    try {
      ws.close(1011, 'Error');
    } catch (e) {}
  }
}
`
