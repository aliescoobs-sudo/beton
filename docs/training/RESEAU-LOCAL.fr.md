# Ouvrir la formation sur le réseau local (téléphone sur le même Wi-Fi)

Données **fictives** uniquement, instance en mode formation (bandeau rouge). Ce n'est **pas** Internet : l'écoute est liée à **une seule adresse privée** du Mac (`10.x`, `172.16–31.x` ou `192.168.x`) sur le port **8443**, jamais à toutes les interfaces. Aucun tunnel, aucune redirection de port du routeur.

## Pourquoi du TLS
Le cookie de session est `Secure` et `__Host-` : un navigateur ne le garde qu'en `https`. Un `http://192.168…` ne marcherait pas (le téléphone se connecterait sans jamais rester connecté). Il n'y a donc pas d'exception « http » : on met un petit proxy TLS (Caddy, profil `lan`) devant l'application, avec un certificat signé par l'autorité interne de Caddy, que le téléphone doit **approuver une fois**.

## Ouvrir (sur le Mac)
1. L'instance tourne (`./scripts/training-up.sh`).
2. `./scripts/training/lan-up.sh` (prend l'adresse de `en0` ; ou `./scripts/training/lan-up.sh 192.168.1.20`). Il : écrit `LAN_BIND_IP` et `APP_BASE_URL=https://<adresse>:8443` dans `.env.training` (0600), démarre `lan-proxy` sur `<adresse>:8443`, redémarre l'application et vérifie que la page de connexion répond.
3. **Le navigateur du Mac doit maintenant utiliser la même adresse** `https://<adresse>:8443/fr/login` : l'application n'accepte les écritures que de cette origine exacte (`http://localhost:3000` ne marche plus tant que le Wi-Fi est ouvert).

Modèle d'adresse : `https://<adresse privée du Mac>:8443/fr/login` (ex. `https://192.168.100.96:8443/fr/login`). Si le routeur donne une autre adresse au Mac (DHCP), relancer `lan-up.sh`.

## Faire approuver l'autorité par le téléphone (une fois)
1. Sur le Mac : `./scripts/training/dc.sh lan-ca > ~/KAYAS-twin/kayas-training-ca.crt` (certificat **public** de l'autorité ; la clé privée reste dans le volume `kayas-training_lan_caddy_data`).
2. L'envoyer au téléphone (AirDrop, câble).
3. **iPhone** : ouvrir le fichier → *Profil téléchargé* → Réglages › Général › VPN et gestion de l'appareil › installer ; puis Réglages › Général › Informations › **Réglages des certificats de confiance** › activer la confiance complète pour « Caddy Local Authority ». **Android** : Réglages › Sécurité › Chiffrement et identifiants › Installer un certificat › *Certificat d'autorité de certification*.
4. Ouvrir `https://<adresse>:8443/fr/login` dans le navigateur du téléphone : cadenas valide, bandeau rouge de formation.

À la fin de l'exercice : retirer le profil du téléphone (Réglages › VPN et gestion de l'appareil › supprimer) — une autorité de confiance qu'on garde est un risque.

## Fermer
`./scripts/training/lan-down.sh` : arrête `lan-proxy`, retire `LAN_BIND_IP`, remet l'application sur `http://localhost:3000`. Les données sont gardées. Pour oublier l'autorité : `docker volume rm kayas-training_lan_caddy_data` (les téléphones devront alors en approuver une nouvelle).

## Ce que ça change, ce que ça ne change pas
- Les comptes de formation restent « mot de passe seul » (sauf ceux qui ont un authentificateur : propriétaire, administrateur) : **toute personne sur ce Wi-Fi qui connaît un mot de passe de formation peut ouvrir l'instance**. À n'utiliser que sur un Wi-Fi de confiance (pas un Wi-Fi public ou partagé), pendant la séance, puis fermer.
- Le proxy ne reçoit aucun secret de l'application. **Attention : le relais de l'hôte masque l'adresse de chaque téléphone** (le proxy ne voit que la machine qui relaie), donc **tous les téléphones partagent le même compteur de verrouillage** : quelques mauvais mots de passe d'un seul téléphone peuvent bloquer les autres pendant le délai prévu. (Avant T10g ce document affirmait à tort un compteur par téléphone.) Le relais limite aussi le nombre de connexions ouvertes (64 en tout, 16 par adresse) et ferme une connexion inactive après trois minutes. L'arrêt normal (`training-down.sh`) et `lan-down.sh` arrêtent le relais **et vérifient** qu'il a disparu.
- `/api/health/*` n'est pas servi par le proxy (404). Cookies, en-têtes, origine, limitation de débit, 2FA, RLS et audit : inchangés.
- Politique R15A-06 (« local seulement ») : cette ouverture est **volontaire, bornée au réseau local, et se ferme par une commande**. Elle ne vaut pas pour la production.
