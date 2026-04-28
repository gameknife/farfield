Farfield desktop packages the existing web UI as a Tauri client shell.

The packaged client expects a Farfield host service at http://127.0.0.1:4311.
The Windows desktop bundle includes a standalone `farfield-server.exe` next to the
desktop executable so the service can be started separately.
