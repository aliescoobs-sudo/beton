# Contrôle interne — règles et séparation des tâches

Version 1 — 15/11/2026 — à valider par la direction.

## 1. Séparation des tâches (jamais la même personne pour deux colonnes)
| Étape | Prépare / saisit | Valide | Signe / paie | Contrôle |
|---|---|---|---|---|
| Vente et facture | Responsable | Direction (seuil) | — | Assistante (échantillon) |
| Encaissement | Responsable | — | Direction (dépôt) | Assistante (comptage) |
| Achat | Assistante | Direction (seuil) | — | Responsable |
| Paiement fournisseur | Assistante | **Direction** | **Direction** | Comptable (mensuel) |
| Rapprochement bancaire | Assistante | **Direction** | — | Comptable |
| Paie | Direction / comptable | Direction | Direction | — |
| Création d'accès | Administrateur de l'app | Direction | — | Direction (revue mensuelle) |

## 2. Seuils de validation (à fixer par la direction)
| Opération | Seuil | Qui valide |
|---|---|---|
| Remise ou prix particulier | toute remise | Direction |
| Échéancier client | > `[X MAD]` ou > `[N]` jours | Direction |
| Bon de commande fournisseur | > `[X MAD]` | Direction |
| Dépense en espèces | > `[X MAD]` | Direction |
| Pièces mécaniques | > `[X MAD]` | Direction |
| Écart de caisse | tout écart ≠ 0 | Direction (information) |

## 3. Pièces obligatoires
- Vente : commande, BL signé, facture.
- Encaissement : copie du chèque / reçu / avis de virement.
- Achat : bon de commande, BL fournisseur, réception, facture.
- Paiement : souche remplie, facture, preuve du débit (relevé).
- Dépense : facture ou reçu.

## 4. Règles d'écriture
- Aucune suppression ; correction par ligne inverse (P9).
- Un mois clos ne se modifie plus.
- Les listes (clients, fournisseurs, catégories) ne se modifient que par la responsable ou la direction ; tout nouveau fournisseur ou client = fiche complète (identité, adresse, contact, ICE / RC si disponible).
- Une seule version de chaque fichier de travail (pas de copies « final2 », « nouveau »).

## 5. Contrôles automatiques dans les fichiers
- Colonne `Doublon ?` (chèques) : alerte rouge si même numéro et même banque.
- Colonne `Écart qté` (achats) : alerte si quantité reçue ≠ quantité du BL fournisseur.
- Colonne `Jours de retard` (échéanciers) : alerte rouge si retard.
- Rapprochement bancaire : écart ≠ 0 en rouge.

## 6. Signalement
Toute anomalie (écart, doublon, pièce falsifiée ou manquante, comportement inhabituel) est notée le jour même dans la liste d'anomalies et transmise à la direction. Signaler une anomalie n'est jamais une accusation : c'est la procédure.

## 7. Accès et sécurité
- Un compte par personne ; mots de passe personnels, jamais partagés, jamais notés sur le poste.
- Fichiers `PERSONNEL` et marges : direction seulement.
- Sauvegarde hebdomadaire des fichiers et sauvegarde mensuelle hors du bureau.
- Revue mensuelle des accès par la direction (qui a accès à quoi).
- Départ d'un salarié : procédure P10 le jour même.
