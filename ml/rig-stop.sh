#!/usr/bin/env bash
# runs ON the rig: stop training / teacher processes (in a file so pkill never matches an ssh command line)
pkill -f "python3 train.py" || true
pkill -f "teacher.py" || true
pkill -f "mug_cli.py" || true
