## Welche Datei brauche ich?

| System | Datei | Hinweis |
|---|---|---|
| **Windows 10/11** | `StreamTunnel_*_x64-setup.exe` | Installer (~1 MB). Doppelklick, fertig. Volle Funktionen inkl. Spiel-Ton einzelner Fenster (Windows 11). |
| **Mac (Apple-Chip M1–M5)** | `StreamTunnel_*_aarch64.dmg` | Für alle aktuellen Macs. Beim ersten Start: Rechtsklick auf die App → **Öffnen** (App ist nicht signiert). |
| **Linux** (und Notlösung überall) | `StreamTunnel.html` | Datei in Chrome/Brave/Chromium öffnen – ohne Installation. Eine kleine Tauri-Linux-App folgt, sobald Linux-WebRTC in Tauri möglich ist. |

Alle Versionen treffen sich im selben Tunnel (gleicher Code).

**Bekannte Grenzen:** Auf dem Mac gibt es keinen Ton einzelner Fenster. Etwa 10–20 % der Netz-Kombinationen (strenges NAT, Firmen-Firewall) brauchen einen eigenen TURN-Server (Einstellungen → Experten).
