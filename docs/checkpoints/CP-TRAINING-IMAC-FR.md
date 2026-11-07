# Installer la version de formation sur l'iMac (en français, pas à pas)

Pour Ali. À faire **sur l'iMac**, dans l'application **Terminal** (Applications → Utilitaires → Terminal). Tape chaque commande, appuie sur Entrée, et vérifie
ce que tu dois voir avant de passer à la suivante. Si ce n'est pas ce qui est écrit : **arrête-toi** et demande de l'aide. Les données sont fictives : tu ne peux rien casser de réel.
Ne copie jamais un mot de passe ou un jeton dans un message, un mail ou un fichier du projet : tu les tapes seulement là où le Terminal les demande.

**1. Empêcher l'iMac de s'endormir et le faire redémarrer après une coupure de courant**
`sudo pmset -a sleep 0 disksleep 0 displaysleep 15 autorestart 1`
Le Terminal demande ton mot de passe Mac (rien ne s'affiche quand tu tapes : c'est normal). Ensuite : `pmset -g | grep -E "sleep|autorestart"`.
✅ Tu dois voir `sleep 0` et `autorestart 1`. Branche l'iMac en **Ethernet** si tu peux.

**1 bis. Garder le disque chiffré (FileVault) et ne PAS activer la connexion automatique**
L'iMac contiendra des secrets (comptes de formation, jeton GitHub, accès Tailscale) : il faut le protéger comme un ordinateur qui garde des mots de passe.
Réglages Système → Confidentialité et sécurité → **FileVault : activé** ; Utilisateurs et groupes → **Connexion automatique : désactivée** ; un mot de passe sur ta session et un verrouillage d'écran.
⚠️ Conséquence : après une coupure de courant, l'iMac redémarre mais **rien ne repart tant que tu n'as pas tapé le mot de passe** à l'écran FileVault. Préviens les
stagiaires que la formation peut être indisponible jusqu'à ce que tu déverrouilles l'iMac.

**2. Installer les outils** (si `brew` n'existe pas, installe d'abord Homebrew depuis https://brew.sh en suivant leur commande)
`brew install colima docker docker-compose docker-credential-helper git gh tailscale`
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
durée 90 jours, coche **seulement `read:packages`** (lecture seule) → Generate. Copie le jeton (tu ne le revois plus).
**Avant de l'utiliser**, fais garder les identifiants Docker dans le **Trousseau macOS** et pas dans un fichier : ouvre `~/.docker/config.json` (`open -e ~/.docker/config.json`)
et vérifie qu'il contient la ligne `"credsStore": "osxkeychain"` (ajoute-la si elle manque, entre les accolades). Test : `docker-credential-osxkeychain version` répond.
Puis dans le Terminal : `docker login ghcr.io -u aliescoobs-sudo`
Quand il écrit **Password:**, colle le jeton (rien ne s'affiche) et Entrée.
✅ Tu vois `Login Succeeded`. Vérifie que le jeton n'a pas été écrit dans un fichier : `grep -c '"auth"' ~/.docker/config.json` doit afficher `0`.
Si ce n'est pas 0 : `docker logout ghcr.io`, supprime le jeton sur github.com et corrige le réglage avant de continuer. Si le jeton apparaît ailleurs que dans ce prompt, supprime-le sur github.com et refais-en un.

**6. Choisir la version à lancer (celle de TON code, pas « la dernière »)**
L'image et le code doivent être le **même commit**. Tape :
`APP_IMAGE=$(./scripts/training/pick-image.sh) ./scripts/training/init-env.sh`
Le script prend le commit de ton dossier (`git rev-parse HEAD`), cherche sur GitHub le passage **vert** de « Build and publish image » **pour ce commit exact**, lit le digest
qu'il a publié avec son commit, et **refuse** s'il n'y en a pas ou si le commit ne correspond pas. Il écrit « wrote .env.training and .env.training.ops » et n'affiche aucun secret.
(Il refuse d'écraser des fichiers existants : c'est voulu.)

**7. Démarrer**
`./scripts/training-up.sh`
La première fois, compte quelques minutes (image, base, données de formation).
✅ À la fin : « The training instance is running on this machine only: http://127.0.0.1:3000 ». Ouvre **http://localhost:3000/fr/login** dans Safari sur l'iMac :
tu vois la bannière rouge « Version de formation — données fictives ».

**Volume neuf et marqueur de naissance (R13-01, R14-13).** La toute première fois que la pile démarre, l'image postgres exécute **une seule fois** `scripts/training/db-init/10-birth-token.sql`
sur le volume tout neuf : il écrit un *marqueur de naissance*. Le seed de formation l'exige, le lie au nom de la base et le consomme avant d'écrire quoi que ce soit. Il refuse les
erreurs courantes (base restaurée ou montée à la main sur une machine sans marqueur, second seed sur le même volume, autre nom de base). **Ce n'est pas une preuve** : c'est un
marqueur consommable, pas un jeton signé ; une restauration de la base de maintenance, du cluster entier ou d'un instantané disque peut emporter un marqueur *non utilisé* ailleurs.
**Un seed réussi ne prouve donc pas que le volume est neuf** : vérifie toi-même, hors du code, que le volume est neuf et dédié. Un ancien volume doit être supprimé
(`./scripts/training/dc.sh down -v`) puis `training-up.sh` relancé ; `reset:training` vérifie lui-même le mode et l'existence d'une ligne de naissance pour cette base. Migrations : toutes, jusqu'à 0118, et celles de la finance.

**8. Donner à chacun SON compte (jamais la liste entière)**
`./scripts/training/show-accounts.sh` affiche seulement les **noms** des comptes, sans secret.
✅ Une liste : propriétaire, administrateur, bureau ventes/achats, deux chefs de centrale, comptable, trois chauffeurs et un pompiste.
Pour un stagiaire : `./scripts/training/show-accounts.sh CH-02` (le **code exact** du chauffeur ; pour un compte e-mail, son **identifiant exact**, par exemple `comptable`) affiche **son bloc seulement**. Un mot générique (`chauffeur`, le domaine `formation.beton.invalid`) est **refusé sans rien afficher** : il désignerait plusieurs personnes. Vérifie qu'un seul bloc s'affiche. Donne-le **en main propre**, puis efface l'écran
**et son historique** (touches ⌘K). Pas de capture d'écran, pas de message, pas d'enregistrement du Terminal (`script`), pas de redirection vers un fichier. Les comptes e-mail n'ont **pas**
de code d'authentification : le mot de passe suffit (seulement dans cette version). **Exception : la finance.** Le propriétaire, l'administrateur et le comptable qui veulent essayer la finance
activent une vraie application d'authentification (lien dans la bannière rouge) : la finance n'accepte jamais le mot de passe seul.

**9. Rendre l'iMac joignable depuis Internet (Tailscale Funnel) : en dernier, et dans cet ordre**
a. `sudo brew services start tailscale` puis `sudo tailscale up` : il affiche un lien, ouvre-le, crée/ouvre ton compte Tailscale gratuit et valide la machine.
✅ `tailscale status` liste l'iMac.
b. Sur https://login.tailscale.com/admin → **DNS** : active **MagicDNS** et **HTTPS Certificates**. La console montre le nom de la machine : l'adresse sera `https://NOM.TON-RESEAU.ts.net`
(**rien n'est public encore**).
c. Donne d'abord cette adresse à l'application : `./scripts/training/set-url.sh https://TON-ADRESSE.ts.net`
✅ Il écrit « the app now accepts requests from https://… ».
d. Ouvre l'accès : `./scripts/training/go-public.sh https://TON-ADRESSE.ts.net`
✅ Il commence par `tailscale funnel reset` et relit l'état : si la fermeture ne peut pas être confirmée il s'arrête avec **« CLOSURE UNCONFIRMED — check Tailscale manually »** (ferme alors Funnel toi-même dans Tailscale et vérifie depuis l'extérieur). Après ouverture il contrôle tout l'état : un seul proxy HTTPS vers l'application, toute autre entrée provoque un refus et la fermeture. Il ne dit jamais « fermé » sans l'avoir relu. **Tout se décide sur l'état structuré complet (`tailscale funnel status --json`, validé par `python3`)** : `python3` est obligatoire ; un Tailscale trop ancien (sans `--json`) ou une erreur du démon sont chacun un refus (le message les distingue), et le texte n'est jamais un repli. Il **refuse** si l'adresse n'est pas celle donnée à l'application, si l'application n'est pas en mode formation ou pas prête ; sinon il lance `tailscale funnel` sur le bon port.
S'il dit que Funnel n'est pas autorisé, il affiche un lien ; ouvre-le, accepte, relance `go-public.sh`.
e. Teste depuis un **téléphone en 4G** (pas le Wi-Fi de la maison) **tout le parcours** : la page de connexion avec la bannière rouge, connexion avec un compte de formation, une modification, déconnexion.
Puis `tailscale funnel reset` : l'adresse ne doit plus répondre. Rouvre avec `go-public.sh` quand la formation commence.

**10. Sauvegarde de nuit** (dans un dossier hors du projet)
`crontab -e` puis ajoute la ligne : `30 2 * * * cd $HOME/belgobeton && ./scripts/training-backup.sh >> $HOME/belgobeton-training-backup.log 2>&1`
✅ Pour tester tout de suite : `./scripts/training-backup.sh` écrit « wrote …/belgobeton-training-backups/training-….dump ».

**Au quotidien**
- Fermer l'accès public quand personne ne s'entraîne : `tailscale funnel reset` ✅ l'adresse ne répond plus.
- Arrêter : `./scripts/training-down.sh` (les données restent). Redémarrer : `./scripts/training-up.sh`.
- **Remettre une journée de travail** (moins d'une minute, comptes et mots de passe inchangés) : `./scripts/training-rearm.sh` crée les commandes du jour, planifie les rotations des trois chauffeurs, ajoute des devis, une commande à annuler, une livraison à recevoir et une alerte de stock bas. À lancer chaque matin avant la séance. Les fiches d'exercices par rôle sont dans `docs/training/`.
- **Remettre à zéro** (efface tout, nouveaux mots de passe) : `./scripts/training-reset.sh`, tape `RESET`, puis `./scripts/training/show-accounts.sh <nom>` pour chaque stagiaire.
- Nouvelle version : `git pull`, puis `./scripts/training/pick-image.sh` (le digest du build vert de CE commit), remplace la ligne `APP_IMAGE=` dans `.env.training`, relance `./scripts/training-up.sh`.
- Ne jamais saisir de vraies données (vrai client, vrai téléphone, vrai chèque).

## Conditions obligatoires avant d'ouvrir le Funnel (R12)
`docs/reviews/CODEX-REVIEW-R12.md` donne un feu vert conditionnel pour une formation surveillée, web et téléphone, avec des données fictives seulement. Les sept
conditions sont obligatoires ; note chacune (sans aucun secret) avant `go-public.sh`. Le Funnel reste fermé tant que les sept ne sont pas notées sur l'iMac.
1. **Version approuvée et volume neuf.** Une copie propre du commit relu et le digest du build vert de CE commit (`pick-image.sh`) ; l'application et `ops` qui
   tournent utilisent ce digest. Toutes les migrations sont appliquées (jusqu'à 0118 et celles de la finance ; le jeton de naissance est encore intact quand le seed démarre et c'est lui qui le consomme). Le projet `belgobeton-training` d'origine sur un volume
   de base de données **neuf** et dédié, rempli par le seed de formation : aucun import, aucune restauration partielle, aucune base métier réutilisée, aucun marqueur
   posé à la main. Garde la preuve que le volume a été créé et que le seed est allé au bout.
2. **Mode et isolation des identifiants.** Dans l'application **qui tourne** : formation activée, données réelles et simulation coupées, `APP_ENV=training`,
   `TRAINING_ALLOW_UNMARKED` absent ou à false (le fichier compose le force à false, et la vérification d'environnement le refuse hors du lanceur de tests), pas de clés
   VAPID ni de fournisseur, la bannière rouge. Aucun identifiant de maintenance, de super-utilisateur ou de seed, et pas de volume des comptes dans l'application. Les
   identifiants restent dans le volume privé d'origine (`/app/out` : uid 10001, dossier 0700, fichier 0600, vérifiés par leurs métadonnées). Ne jamais lancer le seed avec
   un chemin de sortie local ou personnalisé dans une copie du dépôt (le seed le refuse maintenant). Copie de confiance, non partagée, et compte opérateur exclusif
   pour `init-env.sh` et les scripts qui réécrivent les secrets.
3. **Manipulation des identifiants.** FileVault activé, ouverture automatique de session coupée, verrouillage d'écran activé. Docker utilise vraiment l'assistant
   Trousseau, le jeton est `read:packages` seulement, le paquet GHCR est privé. Donne à chacun exactement son bloc avec `show-accounts.sh <identifiant ou code exact>`,
   vérifie qu'UN SEUL bloc s'affiche, sans jamais l'enregistrer, le photographier ni le rediriger. Réinitialise tout identifiant dont le sort est incertain : les données
   sont fictives, les identifiants ne le sont pas.
4. **Fermer, configurer, vérifier, publier.** D'abord `tailscale funnel reset`, et vérifie de l'extérieur que l'adresse ne répond plus. Aucun port de base de données sur
   l'hôte ; l'application sur le seul port local attendu. `set-url.sh <adresse https>`, redémarrage, puis `go-public.sh <adresse https>` : il refait un reset, lit le port
   et l'adresse dans l'application **en cours d'exécution**, exige la réponse « prêt, formation » de cette prise précise et une seule cible proxy dans l'état complet du
   Funnel. Un fichier d'environnement périmé, un conteneur prêt qui n'est pas celui du port, ou un contrôle silencieux ne suffisent pas. Puis un bref essai surveillé en
   données mobiles.
5. **Connexion du téléphone sur le vrai relais.** Des PIN faux en parallèle ne dépassent pas le verrou de cinq échecs par chauffeur ; un bon PIN après le verrou ne le
   lève pas ; les cas de téléphone lié, étranger ou libéré se comportent bien. La limite par adresse verrouille une adresse à travers le vrai Funnel, un `X-Forwarded-For`
   falsifié ou malformé ne change ni ne désactive l'adresse retenue, et une adresse inconnue tombe dans un seul panier commun. On n'accepte que le risque restant de rafale et
   de disponibilité, avec un opérateur prêt à fermer le Funnel. Si le comportement de l'adresse de confiance ou le verrou par chauffeur ne peut pas être montré, on
   n'expose pas l'application téléphone.
6. **Rôles, hors-ligne et finance.** Les requêtes directes non autorisées et les écritures d'une autre origine sont refusées ; les deux chefs de centrale sont séparés ;
   la déconnexion et la révocation d'un téléphone fonctionnent ; un téléphone sans file d'attente se revalide ; la journée disparaît de l'écran à l'expiration même si le
   réseau reste bloqué. Téléphones dédiés et verrouillés ; déconnexion et effacement de la journée et des photos en attente à chaque remise ; ne pas présenter les 18
   heures comme une frontière de confidentialité prouvée. Finance : le mot de passe seul est refusé, le propriétaire, l'administrateur ou le comptable active une vraie
   application d'authentification (QR ou clé), un vrai code frais fait fonctionner les écritures, le comptable exporte. Aucune exception de facteur fictif n'existe.
7. **Surveillance et clôture.** N'ouvre que pendant une séance surveillée, sans vrai client, fournisseur, chèque, document ni photo. Fais une connexion, un changement et
   une déconnexion en HTTPS depuis les données mobiles, sur le web et sur le téléphone. Referme le Funnel ensuite et vérifie de l'extérieur qu'il est fermé ; recommence après
   toute coupure ou redémarrage (`--bg` persiste). Les sauvegardes de nuit sont une reprise sur la même machine, base seule, pas une sauvegarde transportable ; la VPS de
   décembre repart d'un seed neuf.
