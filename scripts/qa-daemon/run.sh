#!/bin/bash
# Arranca el daemon REAL (dist/cli.js serve) con PA_QA_CHANNEL=1, un PA_STATE_DIR
# temporal, el vault portable con secretos falsos, grammy sin red y un modelo falso
# local. Mete las líneas del inbox una a una y espera cada respuesta.
# Requiere `npm run build`. Nada sale a Telegram ni a un proveedor real.
# uso: run.sh <dir de trabajo> <guion.json> <inbox.jsonl> [segundos por línea]
set -u
umask 077
W=$1; SCRIPT=$2; INBOX=$3; SECS=${4:-40}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
HERE=$REPO/scripts/qa-daemon
rm -rf $W; mkdir -p $W/state/qa; touch $W/state/qa/SANDBOX
PORT=$((20000 + RANDOM % 20000))
node $HERE/fakellm.mjs $PORT $SCRIPT $W/requests.jsonl 2> $W/fakellm.log &
LLM=$!
export PA_STATE_DIR=$W/state PA_QA_CHANNEL=1 PA_VAULT_BACKEND=portable PA_DESKTOP=0 TZ=Europe/Madrid
export PA_SECRET_TELEGRAM_BOTTOKEN=123456:fake-token-never-used PA_SECRET_TELEGRAM_ALLOWEDUSERIDS=4242 PA_SECRET_TELEGRAM_OWNERID=4242
export PA_SECRET_PROVIDER_APIKEY=fake PA_API_KEY=fake PA_PROVIDER_PRESET=openrouter PA_BASE_URL=http://127.0.0.1:$PORT/v1 PA_MODEL=test/model
export HOME=$W/home
mkdir -p $HOME
sleep 1
(cd $REPO && timeout -k 5 $((SECS+30)) node --import $HERE/preload.mjs $REPO/dist/cli.js serve > $W/daemon.log 2>&1) &
DPID=$!
# wait until the QA channel is polling (inbox created)
for i in $(seq 1 60); do [ -f $W/state/qa/inbox.jsonl ] && break; sleep 1; done
sleep 3
# one line at a time: wait for a new text reply (or SECS) before the next
while IFS= read -r line; do
  before=$(grep -c '"kind":"text"' $W/state/qa/outbox.jsonl 2>/dev/null || true)
  echo "$line" >> $W/state/qa/inbox.jsonl
  for i in $(seq 1 $SECS); do
    now=$(grep -c '"kind":"text"' $W/state/qa/outbox.jsonl 2>/dev/null || true)
    now=${now:-0}; before=${before:-0}
    [ "$now" -gt "$before" ] && break; sleep 1
  done
  sleep 2
done < $INBOX
pkill -TERM -P $DPID 2>/dev/null; kill -TERM $DPID 2>/dev/null; sleep 5; pkill -KILL -P $DPID 2>/dev/null
kill $LLM 2>/dev/null
echo RUN_DONE
