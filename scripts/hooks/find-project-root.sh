#!/bin/bash
# TEMP recovery shim — see session notes. Returns the workspace root so that
# hooks invoked with a persisted cwd of projects/kivo can resolve. Delete after use.
echo /root/.openclaw/workspace
