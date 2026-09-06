# Eye Host

Minecraft-Panel (Node): Konsole, Dateien, Plugins, Shop, Tickets, Server starten/stoppen.

## Wichtig

Öffentliche Website (wie OnlyClient): https://websitenprogramer.github.io/eyehost/

**GitHub hostet die Website.** Das Panel (Login, Server starten, echte Paysafecard-Zahlung) läuft auf dem Host-PC: `http://localhost:3000`

Eye Host muss auf einem **richtigen Rechner** laufen, der immer an ist:

- dein PC, oder
- ein VPS (z. B. Hetzner, Contabo) mit Node, Java und den Minecraft-Ordnern

GitHub Actions / GitHub Pages können das Panel nicht dauerhaft hosten und auch keine Paper-Server starten.

## Lokal starten

```
node server.js
```

Dann: http://localhost:3000

## Geheimnisse

Nicht ins Repo legen:

- `eyehost-data.json` (Accounts, Sessions)
- `eyehost-settings.json` (Paysafe-Keys, Pfade)

Die Dateien entstehen automatisch, wenn das Panel läuft.
