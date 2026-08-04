# Déploiement du relais ClipSync

Le relais est un petit service Node conteneurisé, exposé en local et servi par
Nginx en HTTPS/WSS sur un sous-domaine. **Aucune donnée sensible dans ce repo** :
remplace les placeholders par tes vraies valeurs.

| Placeholder | Signification                         |
|-------------|---------------------------------------|
| `<VPS_IP>`  | IP publique du serveur                |
| `<domaine>` | sous-domaine du relais (ex. `clip.exemple.com`) |
| `<PORT>`    | port hôte local du conteneur (déf. `8787`) |

## 1. DNS
```
clip.<domaine>   A     <VPS_IP>
clip.<domaine>   AAAA  <VPS_IPv6>   # si IPv6
```

## 2. Récupérer le code sur le VPS
```bash
git clone https://github.com/Pierre542A/clipsync.git
cd clipsync
```

## 3. Démarrer le conteneur (relais sur 127.0.0.1:<PORT>)
```bash
docker compose up -d --build
docker compose logs -f relay      # vérifier "ClipSync relay → ..."
curl -s http://127.0.0.1:8787/health   # -> {"ok":true,...}
```

## 4. Certificat SSL
```bash
sudo certbot certonly --nginx -d clip.<domaine>
```

## 5. Vhost Nginx
```bash
sudo cp deploy/nginx/clip.example.com.conf /etc/nginx/sites-enabled/clip.<domaine>.conf
sudo sed -i 's/clip.example.com/clip.<domaine>/g' /etc/nginx/sites-enabled/clip.<domaine>.conf
sudo nginx -t && sudo systemctl reload nginx
```

→ Test : `wss://clip.<domaine>/ws` (WebSocket) et `https://clip.<domaine>/health`.

## 6. Pointer les clients vers le relais
Dans le client Windows, éditer `%APPDATA%\ClipSync\config.json` :
```json
{
  "ServerUrl": "wss://clip.<domaine>/ws",
  "HttpUrl":   "https://clip.<domaine>",
  "AccountId": "ton-compte",
  "Secret":    "un-secret-partage-fort",
  "DeviceName": "PC Portable"
}
```
> ⚠️ Change `AccountId`/`Secret` (ne garde pas les valeurs de démo). Le **premier**
> appareil qui se connecte avec un `AccountId` fixe son `Secret` ; les autres doivent
> présenter le même. Le chiffrement de bout en bout viendra ensuite.

## Empreinte serveur
1 conteneur Node (~60 Mo), aucune base de données, port local uniquement.
Zéro impact sur les autres projets du VPS (réseau/ports isolés).

Un volume Docker (`clip-data` → `/app/data`) garde les fichiers en transit **24 h**
pour qu'un appareil éteint au moment de l'envoi puisse encore les récupérer. Ils sont
chiffrés côté client, effacés à l'expiration, et plafonnés à 2 Go
(`MAX_STORE_BYTES` — au-delà, les plus anciens partent d'abord).

## Mises à jour
```bash
git pull && docker compose up -d --build
```
