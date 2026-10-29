## Welche Datei brauche ich?

| System | Datei | Hinweis |
|---|---|---|
| **Windows 10/11** | `StreamTunnel-*-Windows-Setup.exe` | Installer (~1 MB). Doppelklick, fertig. Ton kommt automatisch mit: ganzer Bildschirm = Systemton ohne StreamTunnel selbst (kein Echo), einzelnes Fenster = nur der Ton dieses Programms (Windows 10 ab 2004 / Windows 11). |
| **Mac (Apple-Chip M1–M5)** | `StreamTunnel-*-Mac.dmg` | Für alle aktuellen Macs. Die App ist nicht bei Apple registriert: nach dem ersten Startversuch **Systemeinstellungen → Datenschutz & Sicherheit → „Trotzdem öffnen“** (seit macOS 15 geht es nur noch so). |
| **Linux – Arch / CachyOS / Manjaro / Fedora …** | `StreamTunnel-*-Linux-x86_64.tar.gz` | Kleinste Variante (wenige MB): entpacken, `./streamtunnel` starten. Nutzt WebKitGTK und GStreamer deines Systems (Pakete unten). Arch/CachyOS alternativ: `makepkg -si` mit `packaging/arch/PKGBUILD` aus dem Repo. |
| **Linux – Ubuntu / Debian / Mint** | `StreamTunnel-*-Linux.deb` | `sudo apt install ./StreamTunnel-*-Linux.deb` – zieht die nötigen GStreamer-Pakete automatisch mit. |
| **Linux – ohne Installation** | `StreamTunnel-*-Linux.AppImage` | `chmod +x StreamTunnel-*-Linux.AppImage` und starten. Auf Arch/CachyOS braucht das AppImage **`fuse2`** (`sudo pacman -S fuse2`). Größer, weil GTK/WebKit enthalten sind; GStreamer kommt trotzdem vom System. |
| Notlösung überall | `StreamTunnel-*-Browser.html` | Datei in Chrome/Brave/Chromium öffnen – ohne Installation. |

Alle Versionen treffen sich im selben Tunnel (gleicher Code).

**Neu ab 0.2: eigener Direktweg.** Teilt ein Windows-PC mit NVIDIA-Grafik, holt die App das Bild direkt von der Grafikkarte, kodiert es mit NVENC (AV1, HEVC oder H.264) und überträgt es über ein eigenes verschlüsseltes Protokoll mit fester Bitrate – Zuschauer auf Windows, Mac und Linux dekodieren per Grafikkarte und zeigen jedes Bild sofort. Klappt der Direktweg nicht, nutzt die App automatisch den bisherigen Weg.
- **Windows:** beim ersten Teilen fragt die Firewall – **„Zulassen“** (private Netzwerke) wählen.
- **Mac:** beim ersten Zuschauen fragt macOS nach **„Lokales Netzwerk“** – erlauben. Ab 0.2.4 zeigt der Mac das Bild als Videospur (wie Safari Videoanrufe) statt es selbst zu zeichnen – vorher kam auf dem Mac nur ein Bruchteil der Bilder an (Ruckeln).
- Teilen mit AMD-/Intel-Grafik, vom Mac oder von Linux läuft vorerst noch über den bisherigen Weg.
- **Codec** (Qualität-Menü beim Teilen oder Einstellungen): „Auto“ nimmt **AV1** (NVIDIA RTX 40 beim Teilen, Zuschauer mit AV1-Hardware: RTX 30/40, Radeon RX 6000+, Intel Arc), sonst HEVC, sonst H.264 – pro Zuschauer, was er per Grafikkarte kann. Ein Wechsel im Qualität-Menü wirkt sofort bei allen Direktweg-Zuschauern.
- **Vorschau:** wer teilt, sieht sein eigenes Bild als Karte im Tunnel.
- **Gleichmäßiges Bild (ab 0.2.8):** der Zuschauer zeigt jedes Bild im Takt des Senders, statt es sofort beim Eintreffen zu zeichnen. Bilder, die ungleichmäßig ankommen (Netz, Dekoder), verursachen keine Mikroruckler mehr. Das kostet je nach Netz ein paar Millisekunden. „Verzögerung: Flüssiger“ in den Einstellungen gleicht auch stärkere Schwankungen aus.
- **Tipp gegen Ruckeln bei Kameraschwenks:** läuft das Spiel mit mehr FPS als gestreamt werden (z. B. 165 statt 60), liegen zwischen zwei gesendeten Bildern mal 12, mal 18 ms Spielzeit. Das Spiel auf 60 bzw. 120 FPS begrenzen.
- **Bitrate:** der eingestellte Wert ist eine Obergrenze. Braucht das Bild weniger (ruhige oder einfache Szenen), sendet der Encoder weniger. Deshalb zeigt der Zuschauer oft einen kleineren Wert; die Qualität leidet dadurch nicht.

**Linux-Pakete** (einmalig, für tar.gz und AppImage):
- Arch / CachyOS: `sudo pacman -S --needed webkit2gtk-4.1 gst-plugins-base gst-plugins-good gst-plugins-bad libnice gst-libav` – optional `gst-plugin-va` (Grafikkarte dekodiert das Video).
- Ubuntu / Debian: `sudo apt install libwebkit2gtk-4.1-0 gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-nice gstreamer1.0-libav gstreamer1.0-pulseaudio`
- Fehlt etwas, nennt die App beim Ansehen das fehlende Paket.

**Bekannte Grenzen:** Linux kann im Moment **zuschauen** (Bild + Ton, H.264); eigenes Teilen unter Linux folgt. Leeres Fenster unter Linux? Mit `WEBKIT_DISABLE_DMABUF_RENDERER=1 ./streamtunnel` starten. Auf dem Mac gibt es keinen Ton einzelner Fenster. Etwa 10–20 % der Netz-Kombinationen (strenges NAT, Firmen-Firewall) brauchen einen eigenen TURN-Server (Einstellungen → Verbindung).
