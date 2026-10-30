# Protocole ClipSync (v0 — MVP)

Deux canaux :

- **WebSocket** `ws(s)://<host>/ws` — présence, relais des clips, accusés. Messages JSON.
- **HTTP** `http(s)://<host>` — upload/download temporaire des images.

Toutes les valeurs de contenu (`text`, octets d'image) sont destinées à devenir
**opaques** (chiffrées de bout en bout) : le serveur route sans lire. Voir §5.

---

## 1. Modèle d'appairage (MVP)

- Un **compte** est identifié par un `accountId` + un **secret partagé** (`token`).
- Le **premier appareil** qui se connecte avec un `accountId` **définit** le secret.
  Les appareils suivants doivent présenter le **même** secret, sinon rejet.
- Chaque **appareil** a un `deviceId` stable, un `deviceName` lisible et un `platform`
  (`windows` | `ios` | `mac` | `android` | `web` | …).
- Un appareil peut annoncer des **capacités** (`caps`) : voir §7.

> MVP : registre en mémoire côté serveur (perdu au redémarrage).
> Les **fichiers**, eux, sont sur disque et survivent à un redéploiement (§4).
> Cible : appairage par QR code, une paire de clés par appareil, révocation (§5).

---

## 2. WebSocket — client → serveur

### `hello` (obligatoire en premier)
```json
{ "type": "hello", "accountId": "acc-123", "token": "secret-partagé",
  "deviceId": "pc-portable", "deviceName": "PC Portable", "platform": "windows",
  "caps": ["queue"] }
```
- `caps` (facultatif) : `"queue"` = « garde-moi ce qui arrive pendant que je suis
  hors ligne et rejoue-le à ma prochaine connexion » (§7).

### `heartbeat` (toutes ~30 s)
```json
{ "type": "heartbeat" }
```

### `list-devices`
```json
{ "type": "list-devices" }
```

### `clip` — envoyer un élément de presse-papiers
```json
{ "type": "clip", "messageId": "uuid",
  "contentType": "text",            // "text" | "image" | "file"
  "text": "contenu si texte",       // si contentType = text
  "fileId": "uuid-fichier",         // si image/file (cf. HTTP §4)
  "fileType": "image/png",
  "targets": "all",                 // "all" | "default" | ["deviceId", ...]
  "meta": { "filename": "photo.png", "size": 51234 } }
```
- `contentType` : `"image"` = à recoller directement dans le presse-papiers ·
  `"file"` = à enregistrer. Le type MIME réel voyage dans `fileType`.
- `targets` : `"all"` = tous les autres appareils · `"default"` = 1er en ligne
  (MVP) · tableau de `deviceId` = ciblage explicite.
- Un appareil **hors ligne** est ignoré, **sauf** s'il a annoncé `caps: ["queue"]` :
  le clip est alors gardé pour sa prochaine connexion (§7).

### `remove-device` — oublier un appareil
```json
{ "type": "remove-device", "deviceId": "iphone-1" }
```
- Retire l'appareil du registre du compte : il disparaît de la liste de **tous** les
  autres. Sa connexion en cours est fermée après un `removed`.
- Refusé sur soi-même (`cannot remove self`). Le registre étant en mémoire, un
  appareil encore lancé avec la même phrase **se réinscrira** à sa reconnexion :
  c'est au client de le masquer localement s'il ne veut plus le voir.

### `applied` — le destinataire confirme l'écriture dans son presse-papiers
```json
{ "type": "applied", "messageId": "uuid", "to": "deviceId-expéditeur", "success": true }
```
- `to` = le `deviceId` présent dans `clip.from.deviceId` du message reçu.

---

## 3. WebSocket — serveur → client

### `welcome` (réponse à `hello`)
```json
{ "type": "welcome", "deviceId": "pc-portable",
  "devices": [ { "deviceId": "iphone-1", "name": "iPhone de Pierre",
                 "platform": "ios", "online": true, "lastSeen": 1690000000000 } ] }
```

### `devices` (diffusé à chaque changement de présence + périodiquement)
```json
{ "type": "devices", "devices": [ { "deviceId": "...", "name": "...",
  "platform": "...", "online": true, "lastSeen": 1690000000000, "queued": 0 } ] }
```
La liste **exclut** l'appareil destinataire lui-même.
`queued` = nombre de clips en attente pour cet appareil.

### `clip` (relais vers la/les cible(s))
```json
{ "type": "clip", "messageId": "uuid", "contentType": "text|image|file",
  "text": "…", "fileId": "…", "fileType": "image/png", "meta": {},
  "from": { "deviceId": "iphone-1", "name": "iPhone de Pierre" },
  "ts": 1690000000000, "queued": true }
```
- `queued: true` = **rejeu** d'un message reçu pendant que l'appareil était hors
  ligne. Un client qui colle automatiquement dans le presse-papiers doit
  l'archiver **sans** l'appliquer : sinon rouvrir l'app rejouerait tout le passé.

### `sent` (accusé « distribué » renvoyé à l'expéditeur)
```json
{ "type": "sent", "messageId": "uuid", "delivered": 1, "targets": ["pc-portable"],
  "queued": 1, "queuedTargets": ["iphone-1"] }
```
> `sent` = le serveur a poussé le clip aux cibles en ligne — **pas encore** collé.
> `queued` = cibles hors ligne pour lesquelles le clip a été mis de côté.

### `removed` (l'appareil vient d'être oublié)
```json
{ "type": "removed", "ts": 1690000000000 }
```
Envoyé juste avant la fermeture de la socket, suite à un `remove-device`.

### `applied` (accusé « prêt à coller » relayé à l'expéditeur d'origine)
```json
{ "type": "applied", "messageId": "uuid",
  "by": { "deviceId": "pc-portable", "name": "PC Portable" },
  "success": true, "ts": 1690000000000 }
```

### `error`
```json
{ "type": "error", "message": "bad pairing secret" }
```

---

## 4. HTTP — fichiers et images

En-têtes d'authentification requis sur les deux routes :
`x-account-id: <accountId>` et `x-token: <secret>`.

### `POST /files` — upload
- `Content-Type: application/octet-stream`, corps = octets bruts (déjà chiffrés).
- En-tête `x-file-type` = type MIME d'origine (ex. `image/png`).
- Réponse : `{ "fileId": "uuid", "size": 51234, "ttlMs": 604800000 }`
- `413` au-delà de 100 Mo. Le corps est écrit **en
  flux** sur disque : rien n'est bufferisé en mémoire.

### `GET /files/:id` — download
- Renvoie les octets avec le `Content-Type` d'origine.
- `404` si inconnu ou expiré (**TTL 7 jours**). `403` si le fichier appartient à un autre compte.

> Les fichiers vivent sur disque (`FILES_DIR`, volume Docker) et leur index est
> reconstruit au démarrage : un redéploiement ne fait pas disparaître un envoi
> que l'autre appareil n'a pas encore récupéré. Plafond global
> de 2 Go : au-delà, les plus anciens sont supprimés d'abord.

### `GET /health`
- `{ "ok": true, "ts": 1690000000000 }`

---

## 5. Chiffrement de bout en bout (implémenté — v1)

Le serveur ne voit jamais le contenu en clair : il relaie des payloads **opaques**.

**Dérivation de clés** (depuis le secret d'appairage, **jamais transmis**) :
- `authToken = hex(HKDF-SHA256(secret, salt="clipsync-v1", info="clipsync-auth-v1", 32))`
  → valeur envoyée dans `token` (hello) et `x-token` (HTTP). **C'est tout ce que le serveur connaît.**
- `encKey = HKDF-SHA256(secret, salt="clipsync-v1", info="clipsync-enc-v1", 32)`
  → **jamais transmise** ; sert au chiffrement AES-256-GCM.

**Chiffrement** : AES-256-GCM, nonce 12 octets aléatoire, tag 16 octets.
Blob = `nonce(12) ‖ ciphertext ‖ tag(16)` (identique au `combined` de CryptoKit / à l'assemblage .NET).
- **Texte** : le champ `text` = base64(blob), et le clip porte `enc: "v1"`.
- **Image** : les octets envoyés à `POST /files` sont **déjà le blob chiffré** ; le clip porte `enc: "v1"`.

Le serveur authentifie via `authToken` mais **ne peut pas dériver `encKey`** (il n'a jamais le secret) :
même compromis serveur, le presse-papiers reste illisible. Interop .NET ↔ CryptoKit vérifiée par test.

### Feuille de route
- **Appairage par QR code** : transférer `accountId` + secret entre appareils sans le taper.
- **Révocation** d'appareil / secret par appareil.
- **Transport** : déjà en WSS + HTTPS (TLS terminé par Nginx).

---

## 6. Cycle de vie d'un envoi (exemple image, iPhone → PC)

```
iPhone                 Serveur                    PC
  |  POST /files (img) --->|                        |
  |<-- { fileId } ---------|                        |
  |  clip{fileId,targets} ->|  relaie clip --------->|
  |<-- sent{delivered:1} --|                        | GET /files/:id --->|
  |                        |<--- (télécharge) -------|
  |                        |                        | écrit presse-papiers
  |                        |<-- applied{to:iphone} --|
  |<-- applied{success} ---|                        |
  ✓ « Copié sur PC Portable »                        ✓ notif « prêt à coller »
```

---

## 7. File d'attente hors ligne (`caps: ["queue"]`)

Sans elle, envoyer vers un appareil éteint revient à jeter le message : une PWA
fermée (le cas normal sur iPhone) ne recevait jamais rien.

- Un client l'active en annonçant `caps: ["queue"]` dans son `hello`.
- Un clip destiné à un appareil **connu mais hors ligne** qui l'a demandée est
  mis de côté, puis rejoué à sa prochaine connexion avec `queued: true`.
- Plafonds : 100 messages par appareil (les plus récents gagnent) et 7 jours. La file ne contient que des métadonnées — les octets
  sont dans `/files`.
- **Opt-in délibéré** : le client Windows colle automatiquement ce qu'il reçoit.
  Lui rejouer 100 messages au démarrage écraserait son presse-papiers en boucle,
  il ne demande donc pas cette capacité.

> La file est en mémoire : elle ne survit pas à un redémarrage du relais
> (contrairement aux fichiers). C'est le même compromis que le registre (§1).

```
Mac                    Serveur                   iPhone (PWA fermée)
 |  clip{file} -------->|  met de côté            ✗
 |<-- sent{queued:1} ---|
 …                       (plus tard)
 |                      |<--- hello{caps:queue} --| ouverture de la PWA
 |                      |---- clip{queued:true} ->| apparaît dans l'historique
 |                      |<--- GET /files/:id -----| téléchargement à la demande
```
