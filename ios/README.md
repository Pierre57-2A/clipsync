# ClipSync — App iPhone (Swift / SwiftUI)

App iPhone du presse-papiers partagé. **Nécessite un Mac + Xcode** pour compiler.

## Ce qui marche
- **iPhone → PC** : bouton « Envoyer le presse-papiers » + **App Intent / Raccourci**
  (assignable au **triple-tap au dos**, Siri, Centre de contrôle). Envoi en **HTTP**
  (`POST /clip`), donc fonctionne **même app fermée**. Texte **et** images.
- **PC → iPhone (app ouverte)** : réception en direct via **WebSocket** → écrit dans le
  presse-papiers iOS.
- **Présence** : liste des appareils + statut en ligne.

## À venir
- **PC → iPhone app fermée** : nécessite **APNs** (push) + une *Notification Service
  Extension* (boutons `Copier`/`Voir`) et l'envoi de push côté serveur. Étape suivante.
- **Chiffrement bout-en-bout** + appairage **QR** (le secret ira dans le Keychain).

## Compiler

### Option A — XcodeGen (recommandé)
```bash
brew install xcodegen
cd ios
xcodegen generate
open ClipSync.xcodeproj
```
Puis dans Xcode : sélectionne ton équipe de signature (Signing & Capabilities) et lance
sur ton iPhone (déploiement iOS 16+).

### Option B — Projet Xcode manuel
1. Xcode → New → App → *ClipSync*, interface **SwiftUI**, langage **Swift**.
2. Glisse le contenu de `ClipSync/` (dont `Intents/`) dans le projet.
3. Deployment target **iOS 16.0**.

## Configurer (au 1er lancement)
Ouvre l'app → ⚙️ Réglages :
- **Serveur** : `wss://clipsync.lateliercbd.com/ws` · **HTTP** : `https://clipsync.lateliercbd.com`
- **Compte** : un identifiant + un **secret** — *les mêmes que sur tes PC*.

## Assigner le triple-tap au dos
Réglages iOS → **Accessibilité → Toucher → Toucher l'arrière → Triple toucher** →
choisis le raccourci **« Envoyer au PC »** (apparaît une fois l'app installée).

## Fichiers
| Fichier | Rôle |
|---|---|
| `ClipSyncApp.swift` | Point d'entrée + état partagé |
| `Config.swift` | Réglages persistés (UserDefaults) |
| `Protocol.swift` | Modèles (appareils, provenance) |
| `RelayClient.swift` | WebSocket (présence + réception) + HTTP images |
| `ContentView.swift` / `SettingsView.swift` | UI |
| `ClipSender.swift` | Envoi HTTP autonome (pour l'App Intent) |
| `Intents/SendClipboardIntent.swift` | App Intent « Envoyer le presse-papiers » |
| `Intents/ClipSyncShortcuts.swift` | Exposition Siri / Raccourcis / triple-tap |
