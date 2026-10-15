#!/usr/bin/env bash
# Train on the rig (koushi@1080ti-desktop, 3x GTX 1080 Ti).
#   ml/rig.sh push              copy code + features + teacher charts
#   ml/rig.sh start NAME "ARGS" GPU   stop the LLM services and start one training run
#   ml/rig.sh status            tail every run's latest eval
#   ml/rig.sh pull NAME         fetch runs/NAME back
#   ml/rig.sh restore           restart ai-router / power-proxy and check them
set -euo pipefail
RIG=koushi@1080ti-desktop
DATA=${DATA:-$HOME/rg-data}
cd "$(dirname "$0")/.."
case "$1" in
  push)
    rsync -a ml/*.py "$RIG:rg-train/ml/"
    rsync -a "$DATA/manifest.json" "$DATA/feats" "$DATA/teacher" "$RIG:rg-train/data/" ;;
  start)
    # the whole background job must have its stdio redirected or ssh waits for it
    ssh "$RIG" "sudo systemctl stop ai-router.service power-proxy.service; mkdir -p ~/rg-train/runs/$2; \
      (cd ~/rg-train/ml && CUDA_VISIBLE_DEVICES=$4 exec python3 train.py --data ~/rg-train/data --out ~/rg-train/runs/$2 $3) \
      > ~/rg-train/runs/$2/stdout.log 2>&1 < /dev/null &"
    echo "started $2 on GPU $4" ;;
  status)
    ssh "$RIG" 'for d in ~/rg-train/runs/*/; do n=$(basename $d); e=$(grep "\"eval\"" $d/log.jsonl 2>/dev/null | tail -1 | python3 -c "import sys,json; l=sys.stdin.read().strip(); j=json.loads(l) if l else {}; print(j.get(\"step\"), j.get(\"score\"), {k: j[k][\"f1_time\"] for k in (\"easy\",\"normal\",\"hard\") if k in j})"); t=$(tail -1 $d/log.jsonl 2>/dev/null | cut -c1-80); echo "$n | $e | $t"; done; nvidia-smi --query-gpu=index,utilization.gpu,memory.used --format=csv,noheader' ;;
  pull)
    mkdir -p runs && rsync -a "$RIG:rg-train/runs/$2" runs/ ;;
  restore)
    ssh "$RIG" 'sudo systemctl start ai-router.service power-proxy.service; sleep 3; systemctl is-active ai-router.service power-proxy.service' ;;
esac
