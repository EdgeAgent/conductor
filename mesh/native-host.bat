@echo off
rem Conductor mesh native host launcher (Windows).
rem Chrome starts this for Native Messaging; it serves the mesh daemon.
node "%~dp0daemon.mjs" --native
