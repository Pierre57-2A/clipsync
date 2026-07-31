# ClipSync

Presse-papiers **partagé** entre un iPhone et plusieurs PC Windows.
Synchronise **texte et images dans les deux sens**, **partout** (même hors du même réseau),
avec statut de présence des appareils et confirmation « prêt à coller ».

> Projet perso, en service. Client Windows autonome et PWA iPhone, releases construites par la CI.

## Architecture

```
        ┌────────────────────────┐
        │   Serveur relais       │   Node.js + Fastify + WebSocket
        │   (présence + relais)  │   stockage temporaire chiffré des images
        └───────────┬────────────┘
                    │  WSS (commandes/présence)  +  HTTPS (images)
   ┌────────────────┼─────────────────┐
   │                │                 │
 iPhone         PC portable        PC fixe
 (Swift)        (C#/.NET)          (C#/.NET)
```

- **Une fois appairés, les appareils n'ont plus besoin d'être sur le même réseau** :
  tout transite par le serveur relais (HTTPS/WSS), donc iPhone en 4G, PC à la maison, PC au travail.
- **Windows → iPhone** : détection automatique de la copie → notification native iOS (`Copier` / `Voir`).
- **iPhone → Windows** : déclenché par un geste (triple-tap au dos, menu Partager, Centre de contrôle),
  car iOS n'autorise pas la surveillance continue du presse-papiers en arrière-plan.

## Télécharger et utiliser

**iPhone** — ouvre **https://clipsync.lateliercbd.com** dans Safari → Partager → « Sur l'écran
d'accueil ». C'est une **PWA installable**, aucune app à compiler, aucun Mac requis.

**Windows** — télécharge `ClipSync.exe` depuis la
[page Releases](https://github.com/Pierre542A/clipsync/releases). Exécutable **autonome**
(aucune installation de .NET requise), il vit dans la zone de notification.
> ⚠️ L'exe n'est pas signé : au 1er lancement, SmartScreen affiche un avertissement →
> « Informations complémentaires » → « Exécuter quand même ».

Mets le **même identifiant de compte + secret** sur l'iPhone (Réglages de la PWA) et sur
Windows (`%APPDATA%\ClipSync\config.json`) : le presse-papiers est chiffré de bout en bout.

**Héberger ta propre instance** (optionnel, pour être 100 % indépendant) : tout est
self-hostable — voir [`deploy/DEPLOY.md`](deploy/DEPLOY.md) (Docker + Nginx).

## Composants

| Dossier    | Rôle                        | Stack                                   | État |
|------------|-----------------------------|-----------------------------------------|------|
| `server/`  | Relais + **sert la PWA**    | Node.js, Fastify, WebSocket, static     | ✅ **déployé** |
| `server/public/` | **PWA iPhone (sans Mac)** | HTML/JS + Web Crypto (E2E)         | ✅ **live** — `https://clipsync.lateliercbd.com` |
| `windows/` | Client PC (zone de notif)   | C#/.NET 8 (WinForms tray, WebSocket)    | ✅ texte + images |
| `ios/`     | App iPhone **native**       | Swift, SwiftUI, App Intents             | ✅ code (compile sur Mac ; la PWA est l'alternative sans Mac) |

## Démarrer le serveur

```bash
cd server
npm install
npm start
# → http://localhost:8787   ws://localhost:8787/ws
```

Variables d'env utiles : `PORT` (def. 8787), `HOST` (def. 0.0.0.0).

## Sécurité (feuille de route)

- Chiffrement de bout en bout : le serveur ne voit jamais le contenu en clair (payloads opaques).
- Appairage par QR code + secret partagé, révocation d'appareil.
- Images stockées temporairement (TTL 5 min) puis supprimées.

Voir [`docs/PROTOCOL.md`](docs/PROTOCOL.md) pour le protocole de messages.
