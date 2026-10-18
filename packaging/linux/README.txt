StreamTunnel für Linux
======================

Kleine Tauri-App (wenige MB). Bild und Ton laufen über GStreamer aus deinem System,
deshalb braucht es einmalig diese Pakete:

  Arch / CachyOS:
    sudo pacman -S --needed webkit2gtk-4.1 gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad libnice gst-libav
    (optional, Grafikkarte dekodiert: gst-plugin-va)

  Ubuntu / Debian / Mint:
    sudo apt install libwebkit2gtk-4.1-0 gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
      gstreamer1.0-plugins-bad gstreamer1.0-nice gstreamer1.0-libav gstreamer1.0-pulseaudio

Starten:
    ./streamtunnel

Ins Startmenü übernehmen (optional):
    install -Dm755 streamtunnel ~/.local/bin/streamtunnel
    install -Dm644 streamtunnel.png ~/.local/share/icons/hicolor/128x128/apps/streamtunnel.png
    install -Dm644 streamtunnel.desktop ~/.local/share/applications/streamtunnel.desktop

Unter Linux kannst du im Moment Streams ANSEHEN (Bild + Ton) – von Windows-, Mac- und
anderen Mitgliedern im selben Tunnel. Eigenes Teilen unter Linux folgt.
Leeres Fenster? Mit  WEBKIT_DISABLE_DMABUF_RENDERER=1 ./streamtunnel  starten.
