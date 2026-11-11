# Répétition de l'historique importé — rôle par rôle (jumeau fictif)

Données **entièrement fictives** (tous les noms portent « FICTIF », chaque fichier est signé « synthétique »). À faire sur la version de **formation**, jamais sur une base de production. Les vrais fichiers de l'entreprise ne servent qu'à l'import réel (RUNBOOK §4b, décision 210).

## 1. Préparer le jumeau (propriétaire ou administrateur)
1. `corepack pnpm import:twin ./jumeau` : écrit `tetouan/` (8 fichiers, pas de février), `chaoun/` (9 fichiers), `charges/` (9 fichiers) et `mapping/` (3 fichiers de correspondance). Environ 1 200 lignes Tétouan, 800 Chefchaouen, ~160 et ~50 clients avec des quasi-doublons, des lignes sans date ou sans m³, des BL en double, des trous et des valeurs absurdes (Chefchaouen janvier-février), des lignes du mois suivant, des litres dans le texte des dépenses.
2. Lancer l'import (compte propriétaire, version de formation, `TRAINING_MODE=true`) :
   `corepack pnpm import:history --dry-run ./jumeau/tetouan --mapping ./jumeau/mapping/deliveries-tetouan.json` puis `--stage`, de même pour `chaoun` (`deliveries-chaoun.json`) et `charges` (`expenses.json`).
3. Écran **Import historique : décisions** (menu Administration), onglet par onglet : clients (relier un libellé à une fiche, créer, ou garder le libellé ; les groupes proches sont des suggestions), camions, chauffeurs, types de béton (`BB25`, `B25HYD`…), pompe/goulotte (`P SITRAD`), catégories de dépenses, lignes en quarantaine (corriger la date ou les m³, ou écarter).
4. Onglet **Rapprochement** : par centrale et par mois, lignes lues / importées / en quarantaine et somme des m³ lus / importés (à comparer au total de chaque Excel). Le mois `0000-00` regroupe les lignes sans date tant qu'elles ne sont pas corrigées.
5. `--apply` (phrase à taper + code de l'authentificateur). Le retour arrière est `--rollback <identifiant du lot>`.

## 2. Que voit chaque compte une fois le jumeau chargé ?
| Compte | À ouvrir | Ce qu'il doit voir |
|---|---|---|
| **Propriétaire** | Administration → *Import historique : décisions* ; *Historique importé* ; fiche d'un client (relevé) ; *Volumes vendus* | Tous les onglets de décision et le rapprochement ; volumes par centrale, mois et type ; dépenses par catégorie ; sur le relevé d'un client relié, un encadré « historique importé » avec les m³ par mois (aucun montant) ; sur *Volumes vendus*, un lien vers l'historique. |
| **Administrateur (app_admin)** | les mêmes écrans | Identique au propriétaire (même rôle de politique). |
| **Bureau ventes** | menu, puis essayer `/fr/history` | Aucun lien « Historique », l'adresse directe est refusée ; aucune ligne d'historique nulle part ; les commandes, le stock et les factures sont inchangés. |
| **Bureau achats** | idem | Idem : rien de l'historique. |
| **Chef de centrale** (Tétouan, puis Chefchaouen) | *Historique importé* | Seulement **sa** centrale : volumes par mois et par type de béton. Pas d'onglets de décision, pas de dépenses, pas de relevé client. Les lignes sans centrale ne sont pas les siennes. Le tableau de bord de la centrale, le stock et les rotations ne changent pas. |
| **Chauffeur** | l'application téléphone | Uniquement ses rotations : rien de l'historique, aucun nouveau camion ou chauffeur n'apparaît dans le planning. |
| **Pompiste** | l'application téléphone | Idem : rien de l'historique. |
| **Comptable** | *Historique importé* | Seulement **les dépenses par catégorie** (montants, litres de carburant) ; pas de volumes de béton, pas de décisions. Aucune écriture comptable n'est créée : le grand livre, la banque et la caisse sont inchangés. |

## 3. Contrôles à faire pendant la répétition
- Après `--apply`, le stock, les factures, les chèques et les rotations n'ont pas bougé (comparer avant/après).
- Relancer le même `--apply` : « déjà appliqué », rien n'est écrit.
- `--rollback` : l'historique disparaît de tous les écrans à la fois ; les clients créés par le lot sont archivés ; les décisions restent.
- Charger le jumeau sur une base de production, ou un vrai fichier sur la formation : refusé avec un message clair.

Un lot seulement *préparé* (`--stage`) peut être annulé avec `corepack pnpm import:history --rollback <identifiant du lot> --account <email>` (même phrase à taper et même code qu'un lot appliqué) : le lot est marqué annulé, ses lignes en quarantaine sont écartées par le lot (un nouveau `--stage` des mêmes fichiers les rouvre), rien n'est supprimé.
