# Correspondance : fichiers Excel → modules KAYAS

Version 1 — 15/11/2026. Les colonnes des classeurs reprennent la logique des tables de KAYAS afin que l'import soit simple le jour de la bascule. À confirmer avec le travail de l'équipe de développement (spécifications en cours).

| Classeur / onglet | Module KAYAS | Remarques |
|---|---|---|
| `CLIENTS` › Ventes | Commandes, BL, factures | Le BL est créé par la centrale dans KAYAS ; le bureau ne ressaisit plus que les compléments |
| `CLIENTS` › Encaissements | Paiements clients (chèques, espèces, acomptes, effets) | Le contrôle de doublon de chèque existe déjà dans KAYAS |
| `CLIENTS` › Echeancier | Échéanciers et instruments de paiement | Alertes d'échéance 7 jours avant |
| `CLIENTS` › Soldes_Clients | Soldes clients (propriétaire / administrateur) | Visible seulement aux rôles autorisés |
| `FOURNISSEURS` › Achats | Bons de commande `ACH-…`, réceptions | Rapprochement BL fournisseur / réception : alertes |
| `FOURNISSEURS` › Paiements | Paiements fournisseurs, chèques émis | Souche et validation de la direction |
| `FOURNISSEURS` › Echeancier_Fournisseurs | Échéancier fournisseurs | |
| `TRESORERIE` › Caisse, Rapprochement | Caisse, banque, rapprochement | Visibles seulement aux rôles autorisés |
| `CHARGES` | Dépenses (notes de frais, charges) | Justificatif obligatoire |
| `PERSONNEL` (confidentiel) | Paie et avances (si ce module est retenu) | Accès direction seulement |
| `FLOTTE` › Vehicules, Entretien, Carburant | Registre des véhicules, carburant ; l'entretien n'est pas encore un module | À ajouter au backlog si la direction le souhaite |
| `TABLEAU_DE_BORD_PROPRIETAIRE` | Accueil propriétaire (3 cartes, alertes, courbe) | Calculé automatiquement par KAYAS |

## Reprise des données le jour de la bascule
1. Les ventes, encaissements, achats et paiements sont exportés en CSV depuis les classeurs (une ligne = un événement).
2. L'import dans KAYAS passe par la zone d'import (mise en quarantaine, validation, application avec confirmation forte).
3. Les anciens fichiers restent en lecture seule dans `99_Archives`.
4. Les ajustements de soldes d'ouverture (soldes clients et fournisseurs, soldes de banque et de caisse à la date de bascule) sont saisis en **soldes d'ouverture** dédiés, jamais en fausses ventes ou faux paiements.
