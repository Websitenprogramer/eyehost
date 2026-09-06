# Eye Host

Minecraft-Panel (Node): Konsole, Dateien, Plugins, Shop, Tickets, Server starten/stoppen.

## Wichtig

Öffentliche Website: https://websitenprogramer.github.io/eyehost/

Dort geht Anmelden, Tickets, Shop und Server steuern. Das Panel auf dem Host-PC muss dafür laufen.

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
