## Welche Datei brauche ich?

| System | Datei | Hinweis |
|---|---|---|
| **Windows 10/11** | `StreamTunnel-*-Windows-Setup.exe` | Installer (~1 MB). Doppelklick, fertig. Volle Funktionen inkl. Spiel-Ton einzelner Fenster (Windows 11). |
| **Mac (Apple-Chip M1–M5)** | `StreamTunnel-*-Mac.dmg` | Für alle aktuellen Macs. Beim ersten Start: Rechtsklick auf die App → **Öffnen** (App ist nicht signiert). |
| **Linux – Arch / CachyOS / Manjaro / Fedora …** | `StreamTunnel-*-Linux-x86_64.tar.gz` | Kleinste Variante (wenige MB): entpacken, `./streamtunnel` starten. Nutzt WebKitGTK und GStreamer deines Systems (Pakete unten). Arch/CachyOS alternativ: `makepkg -si` mit `packaging/arch/PKGBUILD` aus dem Repo. |
| **Linux – Ubuntu / Debian / Mint** | `StreamTunnel-*-Linux.deb` | `sudo apt install ./StreamTunnel-*-Linux.deb` – zieht die nötigen GStreamer-Pakete automatisch mit. |
| **Linux – ohne Installation** | `StreamTunnel-*-Linux.AppImage` | `chmod +x StreamTunnel-*-Linux.AppImage` und starten. Auf Arch/CachyOS braucht das AppImage **`fuse2`** (`sudo pacman -S fuse2`). Größer, weil GTK/WebKit enthalten sind; GStreamer kommt trotzdem vom System. |
| Notlösung überall | `StreamTunnel-*-Browser.html` | Datei in Chrome/Brave/Chromium öffnen – ohne Installation. |

Alle Versionen treffen sich im selben Tunnel (gleicher Code).

**Linux-Pakete** (einmalig, für tar.gz und AppImage):
- Arch / CachyOS: `sudo pacman -S --needed webkit2gtk-4.1 gst-plugins-base gst-plugins-good gst-plugins-bad libnice gst-libav` – optional `gst-plugin-va` (Grafikkarte dekodiert das Video).
- Ubuntu / Debian: `sudo apt install libwebkit2gtk-4.1-0 gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-nice gstreamer1.0-libav gstreamer1.0-pulseaudio`
- Fehlt etwas, nennt die App beim Ansehen das fehlende Paket.

**Bekannte Grenzen:** Linux kann im Moment **zuschauen** (Bild + Ton, H.264); eigenes Teilen unter Linux folgt. Leeres Fenster unter Linux? Mit `WEBKIT_DISABLE_DMABUF_RENDERER=1 ./streamtunnel` starten. Auf dem Mac gibt es keinen Ton einzelner Fenster. Etwa 10–20 % der Netz-Kombinationen (strenges NAT, Firmen-Firewall) brauchen einen eigenen TURN-Server (Einstellungen → Experten).
