---
description: Branche + commit + push + PR + merge vers main, la prod (pas de staging sur ce dépôt)
---

Publie TOUT le contenu du working tree, pas seulement le travail de la session
en cours : on commit toujours l'intégralité des fichiers modifiés (staged ou
non, liés ou non à la session). C'est une demande EXPLICITE : tu as le droit de
commit, push et merger ici.

Ce dépôt n'a pas d'environnement de staging : `main` est la prod. « prod »,
« main » ou rien → prod. Si on demande « staging » ou « develop », dis qu'il
n'y en a pas ici et arrête-toi sans rien publier. Le reste des arguments sert
de contexte à la PR.

Étapes :

1. `git status` et `git diff` pour voir ce qui a changé.
2. Si je suis sur `main`, ou sur une branche dont la PR est déjà mergée
   (`gh pr view --json state` → `MERGED`), crée une nouvelle branche
   descriptive (`feat/…`, `fix/…`, `chore/…`). Sinon, reste sur la branche
   courante.
3. Ajoute TOUS les fichiers modifiés (`git add -A`) et commit avec un message
   clair en français (titre court + corps si besoin), dans le style du repo.
4. Push la branche (`git push -u origin <branche>`).
5. PR vers `main`, créée par toi avec `gh`, jamais un lien à cliquer. Si une
   PR est déjà ouverte pour la branche, mets à jour son titre et son corps
   (`gh pr edit`) pour qu'ils récapitulent tout le lot ; sinon
   `gh pr create --base main`.
6. Aucun workflow ne tourne sur les PR ici : rien à attendre. Si
   `gh pr checks <n>` en montre un jour, attends-les (`--watch`) et arrête-toi
   sans merger s'ils échouent.
7. Merge : `gh pr merge <n> --merge` (commit de merge).
8. Le merge déclenche `deploiement-vps.yml` (relais et PWA sur
   clipsync.lateliercbd.com) seulement si le lot touche `server/`,
   `docker-compose.yml` ou ce workflow. Dans ce cas, retrouve le run du commit
   de merge (`gh run list --workflow deploiement-vps.yml --commit <sha>`, sha
   donné par `gh pr view <n> --json mergeCommit`, quelques secondes avant
   qu'il apparaisse) et suis-le avec `gh run watch <id> --exit-status`. S'il
   échoue, arrête-toi et explique. Sinon, dis que rien n'est redéployé.
   Le client Windows ne sort pas par ici : c'est un tag `v*`
   (`release-windows.yml`), seulement si je le demande.
9. `git checkout main && git pull`.

À la fin, donne l'URL de la PR et l'état du déploiement.

Contexte / consignes éventuelles pour cette PR : $ARGUMENTS
