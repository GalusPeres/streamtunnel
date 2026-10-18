# StreamTunnel

**Bildschirm & Spiele teilen – direkt von PC zu PC. Ohne Server.**

StreamTunnel ist eine winzige Desktop-App (≈ 1 MB Installer, ≈ 3 MB installiert) für Windows, mit der du deinen
Bildschirm oder **ein einzelnes Spiel samt Spiel-Ton** an Freunde streamst – in hoher Auflösung, mit 60–120 FPS und
sehr niedriger Latenz. Zuschauer treten mit einem 10-stelligen Code bei (z. B. `K7F3Q-X9MZD`).

## Was es kann

- **Einzelne Fenster mit nur deren Ton teilen** (z. B. ein Spiel – Discord-Stimmen und Spotify bleiben draußen)
  oder den ganzen Bildschirm mit Systemton.
- **Bis 4K, bis 120 FPS**, automatische Bitrate (z. B. 1440p60 ≈ 13 Mbit/s mit AV1).
- **Hardware-Encoding (NVENC/AMF/Quick Sync)**: AV1 automatisch, wenn deine Grafikkarte es kann
  (RTX 40/50, Radeon RX 7000+, Intel Arc/Core Ultra), sonst H.264. Zuschauer dekodieren ebenfalls per GPU →
  kaum CPU-Last.
- **Direkte, verschlüsselte P2P-Verbindung** (WebRTC, DTLS-SRTP). Kein Server sieht dein Bild.
- **Weiterleitung über Zuschauer**: Ist dein Upload voll, hängt die App neue Zuschauer automatisch an Zuschauer mit
  gutem Internet (≈ +20–40 ms pro Stufe). So reichen dir 1–3 Uploads auch für größere Gruppen.
- Zuschauerliste mit Verbindungsart, FPS, Bitrate, Latenz, Encoder (Hardware/Software), Rauswerfen, Raum sperren,
  optional Bestätigung neuer Zuschauer, Quelle wechseln ohne Unterbrechung.
- Zuschauer: Vollbild, Mini-Player (immer im Vordergrund), Statistik-Overlay, Modus „Niedrigste Latenz“ / „Flüssig“.

## Benutzung

### Ein Spiel mit Ton teilen
1. StreamTunnel öffnen → **Teilen**.
2. Voreinstellung wählen (z. B. **Spiel (flüssig)** = 1440p · 60 FPS oder **Spiel 120 FPS**).
3. **Teilen starten** → im Dialog den Tab **Fenster** wählen, dein Spiel anklicken und
   **„App-Audio ebenfalls teilen“** einschalten → **Mit Audio teilen**.
4. Den angezeigten Code (oder „Einladung kopieren“) an deine Freunde schicken. Das Fenster darfst du minimieren.

Tipp: Spiele im **randlosen Fenstermodus** starten – exklusiver Vollbildmodus lässt sich bei manchen Spielen nicht
aufnehmen. Den ganzen Bildschirm teilst du über den Tab **Gesamter Bildschirm** (mit Systemton).

### Zuschauen
StreamTunnel öffnen → Code bei **Zuschauen** eingeben (Einfügen einer Einladung funktioniert auch) → **Beitreten**.
Tasten: `F` Vollbild · `Esc` Vollbild beenden · `S` Statistik · `M` Ton aus · `L` Latenzmodus.

## Wie funktioniert der „Tunnel“ ohne Server?

```
Host ──(verschlüsselte Verbindungsdaten über öffentliche MQTT-Broker)──► Zuschauer
Host ════════════ direkte WebRTC-P2P-Verbindung (Bild + Ton) ══════════► Zuschauer
```

- Zum **Finden** nutzt die App gleichzeitig vier kostenlose öffentliche MQTT-Broker (Mosquitto, Coreflux, HiveMQ,
  TBMQ). Über sie laufen nur ein paar KB **AES-GCM-verschlüsselte** Verbindungsdaten; der Schlüssel wird aus dem
  Raum-Code abgeleitet (PBKDF2 + HKDF). Fällt ein Broker aus, übernehmen die anderen.
- Danach fließen Bild und Ton **direkt** zwischen den PCs (STUN-Lochstanzen durch Router/NAT).
- Die Broker-Liste, STUN- und optionale TURN-Server kannst du unter **Erweitert** (Zahnrad) ändern.

## Grenzen & Problemlösung

| Problem | Lösung |
|---|---|
| „Direkte Verbindung fehlgeschlagen“ | Bei ca. 10–20 % der Netz-Kombinationen (strenges NAT/CGNAT, Firmen-Firewall, manche VPNs) klappt P2P nicht. Anderes Netz/Hotspot testen, VPN aus, oder unter **Erweitert** einen eigenen TURN-Server eintragen. |
| Kein Ton beim Fenster-Teilen | Im Dialog **„App-Audio ebenfalls teilen“** aktivieren → in der App **Quelle wechseln**. |
| Bild schwarz | Spiel im randlosen Fenstermodus starten. |
| Warnung „Software-Encoder aktiv“ | Auflösung/FPS senken oder Codec H.264 wählen (z. B. 4K60 übersteigt manche Hardware-Encoder). |
| Ruckelt bei vielen Zuschauern | Upload begrenzt: **Max. direkte Zuschauer** senken oder **Upload-Limit** setzen – die übrigen laufen über Weiterleitung. |

Jeder **direkte** Zuschauer kostet eine Encoder-Sitzung und Upload (1440p60 AV1 ≈ 13 Mbit/s). NVIDIA-Consumer-GPUs
erlauben ca. 8 gleichzeitige Encoder-Sitzungen. RAM-Bedarf der Engine (WebView2): ca. 150–300 MB.

## Plattformen & Downloads

Downloads: unter **Releases** (fertige Versionen) bzw. **Actions → Build → Artifacts** (jeder Build). Alle Builds sind
unsigniert.

| Plattform | Download | Stand |
|---|---|---|
| **Windows** | `StreamTunnel_…_x64-setup.exe` | Voller Funktionsumfang. |
| **macOS** (Apple Silicon / Intel) | `StreamTunnel_…_aarch64.dmg` / `…_x64.dmg` | Tauri-App (WKWebView): Zuschauen funktioniert, Teilen ab macOS 14 wahrscheinlich, **kein App-Audio** einzelner Fenster. Noch ungetestet. |
| **Linux** | `StreamTunnel.html` (empfohlen), `.AppImage` / `.deb` | Die Tauri-App (WebKitGTK) hat kein WebRTC → stattdessen `StreamTunnel.html` per Doppelklick in **Chrome** oder **Firefox** öffnen. Zuschauen geht überall; Bildschirm mit Ton teilen in Chrome über PipeWire, wo unterstützt. |

`StreamTunnel.html` ist die komplette App in einer Datei und läuft ohne Installation in jedem aktuellen Browser
(auch unter Windows/macOS).

**macOS – unsignierte App öffnen:** Rechtsklick auf die App → **Öffnen** → **Öffnen** bestätigen. Hilft das nicht
(„beschädigt“): im Terminal `xattr -cr /Applications/StreamTunnel.app` ausführen.
**Linux – AppImage:** `chmod +x StreamTunnel_*.AppImage` und starten.

## Voraussetzungen

- Windows 10 oder 11 mit WebView2 (ist vorinstalliert; der Installer lädt es sonst automatisch).
- App-Audio einzelner Fenster nutzt die Windows-Prozess-Loopback-Aufnahme und braucht **Windows 11**
  (unter Windows 10 gibt es Ton nur beim Teilen des ganzen Bildschirms).
- macOS/Linux: siehe [Plattformen & Downloads](#plattformen--downloads).

## Entwicklung

```bash
npm install
npm run tauri dev        # App mit Hot-Reload starten
npm test                 # Unit- und Live-Broker-Tests (ST_OFFLINE=1 überspringt Live-Tests)
npm run e2e              # Headless-End-to-End-Test (Edge): Host, Zuschauer, Weiterleitung, Quellwechsel
npm run tauri build      # Release-Build + NSIS-Installer (src-tauri/target/release/bundle/nsis)
npm run build:web        # Web-Version in einer Datei: dist-web/StreamTunnel.html (läuft per Doppelklick)
```

CI (`.github/workflows/build.yml`): jeder Push auf `main` (oder manuell über **Run workflow**) baut Windows, macOS
(arm64 + x64), Linux und `StreamTunnel.html` als Artifacts; ein Tag `v*` (z. B. `git tag v0.1.0 && git push origin
v0.1.0`) legt zusätzlich ein Release-Draft mit allen Dateien an.

Im Browser unter `http://localhost:1420/?test` gibt es zusätzlich **Testbild senden** (Testmuster mit Ton, ohne
Bildschirmauswahl).

Architektur und Protokoll: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
src/core/        Raum-Code, Kryptografie
src/signaling/   MQTT-über-WebSocket-Client, verschlüsselter Multi-Broker-Raum
src/rtc/         Aufnahme, Codec-Wahl, SDP-Tuning, Statistik, HostSession (inkl. Weiterleitung), ViewerSession
src/ui/          Oberfläche (Vanilla TypeScript, keine Frameworks)
src-tauri/       Tauri-Hülle, Engine-Flags (Hardware-AV1), keep_awake-Befehl
tests/           Unit-, Live- und E2E-Tests
```
