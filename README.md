# StreamTunnel

**Bildschirm & Spiele teilen – direkt von PC zu PC. Ohne Server.**

StreamTunnel ist eine winzige Desktop-App (≈ 1 MB Installer, ≈ 3 MB installiert). Ihr trefft euch in einem
**Tunnel** – einem privaten Raum mit 10-stelligem Code (z. B. `K7F3Q-X9MZD`). Alle sind gleichberechtigt: **jeder kann
seinen Bildschirm oder ein einzelnes Spiel samt Spiel-Ton teilen, alle anderen schauen zu** – in hoher Auflösung,
mit 60–120 FPS und sehr niedriger Latenz. Kein Host, kein Server, kein Konto.

## Was es kann

- **Tunnel statt Host:** einer erstellt den Tunnel, die anderen treten per Code bei. Jeder sieht, wer da ist und
  wer gerade live ist. Mehrere dürfen gleichzeitig teilen.
- **Einzelne Fenster mit nur deren Ton teilen** (z. B. ein Spiel – Discord-Stimmen und Spotify bleiben draußen)
  oder den ganzen Bildschirm mit Systemton. Der Spielname wird den anderen angezeigt.
- **Bis 4K, bis 120 FPS**, automatische Bitrate (z. B. 1440p60 ≈ 13 Mbit/s mit AV1).
- **Hardware-Encoding (NVENC/AMF/Quick Sync)**: AV1 automatisch, wenn die Grafikkarte es kann
  (RTX 40/50, Radeon RX 7000+, Intel Arc/Core Ultra), sonst H.264. Zuschauer dekodieren per GPU → kaum CPU-Last.
- **Direkte, verschlüsselte P2P-Verbindungen** (WebRTC, DTLS-SRTP). Kein Server sieht euer Bild.
- **Nativer Modus zwischen zwei Apps** (neu; Teilen unter Windows mit NVIDIA-Grafikkarte): Aufnahme und Encoding
  laufen direkt auf der GPU (NVENC, HEVC oder H.264), das Bild geht über ein eigenes verschlüsseltes UDP-Protokoll
  und wird beim Zuschauen sofort gezeichnet – ohne Puffer, mit fester Auflösung und FPS. Klappt das nicht (keine
  NVIDIA-Karte, Browser, gesperrtes Netz), schaltet die App von selbst auf den normalen Weg (WebRTC).
- **Weiterreichen unter Zuschauern:** Ist der Upload des Teilenden voll, bekommen weitere Zuschauer das Bild
  automatisch über andere Zuschauer (≈ +20–40 ms pro Stufe). So reichen 1–3 Uploads auch für größere Gruppen.
- Rahmenloses, dunkles Fenster; beim Zuschauen nur das Bild (Steuerung erscheint bei Mausbewegung), Vollbild,
  Mini-Player (immer im Vordergrund), Statistik-HUD (`S`), Modus „Niedrigste Latenz“ / „Flüssig“.

## Benutzung

1. StreamTunnel öffnen → **Neuen Tunnel erstellen** – oder den Code eines Freundes eingeben → **Beitreten**.
2. Code oben links anklicken (kopiert ihn) und an Freunde schicken.
3. **Teilen:** auf **Teilen** bzw. **Bildschirm teilen** klicken → im Windows-Dialog Tab **Fenster** → dein Spiel
   anklicken → **„App-Audio ebenfalls teilen“** einschalten → **Mit Audio teilen**. Fertig, du bist live.
   Qualität (FPS, Flüssig/Scharf, Bitrate) kannst du unten während des Streams ändern.
4. **Zuschauen:** in der Liste bei jemandem mit **LIVE** auf **Ansehen** klicken. `Esc` bringt dich zurück.

Tasten beim Zuschauen: `F` Vollbild · `Esc` zurück · `S` Statistik · `M` Ton aus · `L` Latenzmodus.

Tipp: Spiele im **randlosen Fenstermodus** starten – exklusiver Vollbildmodus lässt sich bei manchen Spielen nicht
aufnehmen. Den Auswahldialog zeichnet Windows selbst; er lässt sich nicht umgestalten.

## Wie funktioniert der „Tunnel“ ohne Server?

```
Alle im Tunnel ──(verschlüsselte Kurznachrichten über öffentliche MQTT-Vermittler)── finden sich
Teilende ═══════ direkte WebRTC-P2P-Verbindungen (Bild + Ton) ═══════► Zuschauer ═══► weitere Zuschauer
```

- Zum **Finden** nutzt die App gleichzeitig vier kostenlose öffentliche MQTT-Vermittler (Mosquitto, Coreflux,
  HiveMQ, TBMQ). Darüber laufen nur ein paar KB **AES-GCM-verschlüsselte** Nachrichten („wer ist da, wer teilt“,
  Verbindungsdaten); der Schlüssel wird aus dem Tunnel-Code abgeleitet (PBKDF2 + HKDF). Fällt einer aus,
  übernehmen die anderen.
- Bild und Ton fließen **direkt** zwischen den PCs (STUN-Lochstanzen durch Router/NAT).
- Vermittler, STUN- und optionale TURN-Server kannst du in den **Einstellungen** (Regler-Symbol oben rechts) ändern.

## Grenzen & Problemlösung

| Problem | Lösung |
|---|---|
| „Direkte Verbindung fehlgeschlagen“ | Bei ca. 10–20 % der Netz-Kombinationen (strenges NAT/CGNAT, Firmen-Firewall, manche VPNs) klappt P2P nicht. Anderes Netz/Hotspot testen, VPN aus, oder in den **Einstellungen** einen eigenen TURN-Server eintragen. |
| Kein Ton beim Fenster-Teilen | In der App **Quelle wechseln** und im Dialog **„App-Audio ebenfalls teilen“** aktivieren. |
| Bild schwarz | Spiel im randlosen Fenstermodus starten. |
| Warnung „Software-Encoder aktiv“ | Auflösung/FPS senken oder Codec H.264 wählen (z. B. 4K60 übersteigt manche Hardware-Encoder). |
| Ruckelt bei vielen Zuschauern | Upload begrenzt: in den Einstellungen **Direkte Zuschauer** senken oder ein **Upload-Limit** setzen – die übrigen bekommen das Bild weitergereicht. |

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

**Nativer Modus** (nur zwischen zwei Apps): teilen kann vorerst nur Windows mit NVIDIA-Grafikkarte, zuschauen jede
App (Windows, macOS, Linux; der Mac bekommt H.264). Alles andere läuft automatisch über WebRTC. Im Statistik-HUD
(`S`) steht dann z. B. „Nativ · HEVC · NVENC · 36 Mbit/s · RTT 1 ms“. Beim ersten nativen Stream kann Windows nach
einer Firewall-Freigabe fragen – für private Netzwerke erlauben. Die Umgebungsvariable `ST_NATIVE=0` schaltet den
Modus zum Vergleichen ab.

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
npm run e2e              # Headless-End-to-End-Test (Edge): Tunnel, Teilen, Zuschauen, Weiterreichen
node tests/e2e/native-decode.mjs   # Headless: Bild und Ton des nativen Modus (aufgenommener Teststrom)
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
src/rtc/         Tunnel (Mitglieder), Aufnahme, Codec-Wahl, SDP-Tuning, Statistik, Senden (inkl. Weiterreichen), Empfangen
src/ui/          Oberfläche (Vanilla TypeScript, keine Frameworks)
src-tauri/       Tauri-Hülle, Engine-Flags (Hardware-AV1), keep_awake-Befehl, nativer Modus (native_media.rs)
src-tauri/st-media/  nativer Modus: Windows-Aufnahme + NVENC, UDP-Protokoll stm/1 (docs/NATIVE-PATH.md)
tests/           Unit-, Live- und E2E-Tests
```

## Lizenzen von Drittanbietern

Der native Modus nutzt für die Fehlerkorrektur `reed-solomon-simd` (MIT). Die Bibliothek beruht auf Leopard-RS
(BSD-3-Clause); dessen Hinweis:

```
Copyright (c) 2017 Christopher A. Taylor.  All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice,
  this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.
* Neither the name of Leopard-RS nor the names of its contributors may be
  used to endorse or promote products derived from this software without
  specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

Die NVENC-Schnittstelle (NVIDIA Video Codec SDK 12.0, nv-codec-headers) steht unter MIT; ihr Hinweis steht in
`src-tauri/st-media/src/win/nvenc_sys.rs`.
