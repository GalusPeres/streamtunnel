## Welche Datei brauche ich?

| System | Datei | Hinweis |
|---|---|---|
| **Windows 10/11** | `StreamTunnel_*_x64-setup.exe` | Installer (~1 MB). Doppelklick, fertig. Volle Funktionen inkl. Spiel-Ton einzelner Fenster (Windows 11). |
| **Mac mit Apple-Chip (M1–M4)** | `StreamTunnel_*_aarch64.dmg` | Für alle aktuellen Macs. Beim ersten Start: Rechtsklick auf die App → **Öffnen** (App ist nicht signiert). |
| **Mac mit Intel-Chip (vor 2020)** | `StreamTunnel_*_x64.dmg` | Nur für ältere Intel-Macs. |
| **Linux (alle Distros, z. B. CachyOS/Arch, Fedora)** | `StreamTunnel-*-x86_64.AppImage` | `chmod +x StreamTunnel-*.AppImage` und starten. Auf Arch/CachyOS einmal `sudo pacman -S fuse2`. Unter Ubuntu 24.04+ ggf. mit `--no-sandbox` starten. |
| **Linux (Ubuntu/Debian)** | `StreamTunnel-*-amd64.deb` | `sudo apt install ./StreamTunnel-*-amd64.deb` |
| **Notlösung im Browser** | `StreamTunnel.html` | Datei in Chrome/Edge/Firefox öffnen – ohne Installation. |

Alle Versionen treffen sich im selben Tunnel (gleicher Code).

**Bekannte Grenzen:** Ton vom Linux-PC aus wird noch nicht übertragen (Bild schon). Auf dem Mac gibt es keinen Ton einzelner Fenster. Etwa 10–20 % der Netz-Kombinationen (strenges NAT, Firmen-Firewall) brauchen einen eigenen TURN-Server (Einstellungen → Experten).
