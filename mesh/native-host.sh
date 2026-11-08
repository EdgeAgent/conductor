#!/bin/sh
# Conductor mesh native host launcher. Chrome starts this process for
# Native Messaging; it serves the mesh daemon's stdio protocol.
# Mesh state lives in $MESH_HOME (default ~/.meshnode).
exec node "$(dirname "$0")/daemon.mjs" --native
