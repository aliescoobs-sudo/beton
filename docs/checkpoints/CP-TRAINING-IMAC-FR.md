# Installer la version de formation sur l'iMac (en français, pas à pas)

Pour Ali. À faire **sur l'iMac**, dans l'application **Terminal** (Applications → Utilitaires → Terminal). Tape chaque commande, appuie sur Entrée, et vérifie
ce que tu dois voir avant de passer à la suivante. Si ce n'est pas ce qui est écrit : **arrête-toi** et demande de l'aide. Les données sont fictives : tu ne peux rien casser de réel.
Ne copie jamais un mot de passe ou un jeton dans un message, un mail ou un fichier du projet : tu les tapes seulement là où le Terminal les demande.

**1. Empêcher l'iMac de s'endormir et le faire redémarrer après une coupure de courant**
`sudo pmset -a sleep 0 disksleep 0 displaysleep 15 autorestart 1`
Le Terminal demande ton mot de passe Mac (rien ne s'affiche quand tu tapes : c'est normal). Ensuite : `pmset -g | grep -E "sleep|autorestart"`.
✅ Tu dois voir `sleep 0` et `autorestart 1`. Branche l'iMac en **Ethernet** si tu peux.

**2. Installer les outils** (si `brew` n'existe pas, installe d'abord Homebrew depuis https://brew.sh en suivant leur commande)
`brew install colima docker docker-compose git gh tailscale`
✅ À la fin, `colima version` et `docker --version` affichent un numéro de version.

**3. Démarrer le moteur Docker (Colima)** : 4 Go de mémoire, 20 Go de disque minimum libres
`colima start --arch x86_64 --cpu 2 --memory 4 --disk 40`
puis `brew services start colima` (pour qu'il redémarre tout seul).
✅ `docker info` répond sans message d'erreur (il écrit « Server Version … »).

**4. Récupérer le projet**
`gh auth login` : choisis GitHub.com → HTTPS → « Login with a web browser ». Le navigateur s'ouvre, tu valides, rien à coller.
Puis `gh repo clone aliescoobs-sudo/beton ~/belgobeton && cd ~/belgobeton`
✅ `ls scripts/training-up.sh` affiche le nom du fichier.

**5. Autoriser l'iMac à télécharger l'image privée (GHCR) avec TON jeton en lecture seule**
Sur github.com : ta photo → Settings → Developer settings → Personal access tokens → **Tokens (classic)** → Generate new token (classic) → nom « iMac formation »,
durée 90 jours, coche **seulement `read:packages`** → Generate. Copie le jeton (tu ne le revois plus). Puis dans le Terminal :
`docker login ghcr.io -u aliescoobs-sudo`
Quand il écrit **Password:**, colle le jeton (rien ne s'affiche) et Entrée.
✅ Tu vois `Login Succeeded`. Si le jeton apparaît ailleurs que dans ce prompt, supprime-le sur github.com et refais-en un.

**6. Choisir la version à lancer**
Sur github.com → le dépôt → onglet **Actions** → le dernier passage vert de **Build and publish image** → dans le résumé, copie la ligne **Digest to deploy** (`sha256:…`). Puis :
`APP_IMAGE=ghcr.io/aliescoobs-sudo/belgobeton@sha256:COLLE_ICI_LE_DIGEST ./scripts/training/init-env.sh`
✅ Il écrit « wrote .env.training and .env.training.ops » et n'affiche aucun secret. (Il refuse d'écraser des fichiers existants : c'est voulu.)

**7. Démarrer**
`./scripts/training-up.sh`
La première fois, compte quelques minutes (image, base, données de formation).
✅ À la fin : « The training instance is running on this machine only: http://127.0.0.1:3000 ». Ouvre **http://localhost:3000/fr/login** dans Safari sur l'iMac :
tu vois la bannière rouge « Version de formation — données fictives ».

**8. Lire les comptes (une seule fois)**
`./scripts/training/show-accounts.sh`
✅ Une liste : propriétaire, administrateur, bureau ventes/achats, deux chefs de centrale, comptable, trois chauffeurs et un pompiste, chacun avec son mot de passe ou son PIN.
Donne à chacun sa ligne **en main propre**, puis efface l'écran (`clear`). Les comptes e-mail n'ont **pas** de code d'authentification : le mot de passe suffit (seulement dans cette version).

**9. Rendre l'iMac joignable depuis Internet (Tailscale Funnel)**
a. `sudo brew services start tailscale` puis `sudo tailscale up` : il affiche un lien, ouvre-le, crée/ouvre ton compte Tailscale gratuit et valide la machine.
✅ `tailscale status` liste l'iMac.
b. Sur https://login.tailscale.com/admin → **DNS** : active **MagicDNS** et **HTTPS Certificates**.
c. `tailscale funnel --bg 3000` : s'il dit que Funnel n'est pas autorisé, il affiche un lien ; ouvre-le, accepte, relance la commande.
✅ Il affiche l'adresse publique `https://…ts.net`. Note-la.
d. Donne cette adresse à l'application : `./scripts/training/set-url.sh https://TON-ADRESSE.ts.net`
✅ Il écrit « the app now accepts requests from https://… ». Teste depuis un **téléphone en 4G** (pas le Wi-Fi de la maison) : la page de connexion s'ouvre avec la bannière rouge.

**10. Sauvegarde de nuit** (dans un dossier hors du projet)
`crontab -e` puis ajoute la ligne : `30 2 * * * cd $HOME/belgobeton && ./scripts/training-backup.sh >> $HOME/belgobeton-training-backup.log 2>&1`
✅ Pour tester tout de suite : `./scripts/training-backup.sh` écrit « wrote …/belgobeton-training-backups/training-….dump ».

**Au quotidien**
- Fermer l'accès public quand personne ne s'entraîne : `tailscale funnel reset` ✅ l'adresse ne répond plus.
- Arrêter : `./scripts/training-down.sh` (les données restent). Redémarrer : `./scripts/training-up.sh`.
- **Remettre à zéro** (efface tout, nouveaux mots de passe) : `./scripts/training-reset.sh`, tape `RESET`, puis `./scripts/training/show-accounts.sh`.
- Nouvelle version : prends le nouveau digest (étape 6), remplace la ligne `APP_IMAGE=` dans `.env.training`, relance `./scripts/training-up.sh`.
- Ne jamais saisir de vraies données (vrai client, vrai téléphone, vrai chèque).
