# Structure des classeurs Excel

Version 1 — 15/11/2026. Généré à partir des modèles : chaque classeur contient un onglet **Aide** (mode d'emploi, exemples fictifs), les onglets de travail, un onglet **Parametres** (hypothèses en cellules bleues) et un onglet **Listes** (listes déroulantes).

## Règles communes
- Une ligne = un événement ; pas de cellules fusionnées ; pas de mois par onglet.
- En-tête **bleu foncé** = à saisir ; en-tête **gris** = formule (ne pas modifier).
- Formules prêtes jusqu'à la ligne 2000 ; au-delà, copier la dernière ligne vers le bas.
- Aucune suppression : correction par ligne inverse (procédure P9).
- Alertes automatiques : doublon de chèque, écart de quantité, validation manquante, échéance dépassée, écart de rapprochement, échéance d'assurance ou de visite.

Les classeurs sont regroupés par fonction (et non un fichier par tableau) pour que les soldes se calculent seuls : par exemple `CLIENTS` contient Ventes, Encaissements et Echeancier, donc `Soldes_Clients` est automatique.

| Classeur | Contenu | Visibilité |
|---|---|---|
| `CLIENTS_2026.xlsx` | Ventes, Encaissements, Echeancier, Soldes_Clients, Synthese_Mensuelle | Responsable, assistante (lecture), direction |
| `FOURNISSEURS_2026.xlsx` | Achats, Paiements, Echeancier_Fournisseurs, Soldes_Fournisseurs, Synthese_Mensuelle | Assistante, direction ; responsable en lecture |
| `TRESORERIE_2026.xlsx` | Caisse, Comptage_caisse, Rapprochement | Responsable, assistante, direction |
| `CHARGES_2026.xlsx` | Charges, Synthese_Mensuelle | Assistante, direction |
| `PERSONNEL_2026_CONFIDENTIEL.xlsx` | Salaries, Paie, Avances, Soldes_Avances | **Direction uniquement** |
| `FLOTTE.xlsx` | Vehicules, Entretien, Carburant | Assistante, mécanicien (Entretien), direction |
| `TABLEAU_DE_BORD_PROPRIETAIRE.xlsx` | Tableau_mensuel | **Direction uniquement** |

Hypothèses à confirmer (onglets Parametres) : taux de TVA 20 %, jours d'alerte 30, seuil de validation de la direction (vide : à fixer).


# CLIENTS_2026.xlsx

## Onglet « Ventes »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| N° BL | saisie | Numéro du bon de livraison, identique au papier. Ex. : BL-2026-00012 |
| Date | saisie | Ex. : 15/11/2026 |
| Client | saisie | Liste déroulante (onglet Listes). Ex. : Client Exemple SARL |
| Centrale | saisie | Ex. : Centrale Tétouan |
| Chantier / lieu | saisie | Ex. : Chantier Exemple, Tétouan |
| Classe | saisie | Ex. : B25 |
| Mode | saisie | POMPE : le service de pompage est inclus dans le prix, pas de ligne séparée. Ex. : POMPE |
| Volume (m³) | saisie | Volume réellement livré. Ex. : 8 |
| Prix HT / m³ | saisie | Prix de la grille officielle pour la classe et le mode, ou prix accordé par la direction. Ex. : 820 |
| Montant HT | formule | = Volume × Prix HT. Ex. : 6560 |
| TVA | formule | = Montant HT × taux de TVA (onglet Parametres). Ex. : 1312 |
| Montant TTC | formule | Ex. : 7872 |
| N° facture | saisie | Renseigné quand la facture est émise. Ex. : VTE-2026-00123 |
| N° commande / BC client | saisie | Ex. : CMD-2026-00044 |
| Saisi par | saisie | Ex. : initiales |
| Observations | saisie | Réserves, refus, retour, correction (référence de la ligne corrigée). |

## Onglet « Encaissements »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| N° pièce | saisie | Numéro unique de l'encaissement. Ex. : ENC-2026-045 |
| Date de réception | saisie | Ex. : 15/11/2026 |
| Client | saisie | Ex. : Client Exemple SARL |
| Mode | saisie | Ex. : Chèque |
| Montant | saisie | Ex. : 7872 |
| N° chèque / effet / réf. virement | saisie | Obligatoire pour chèque, effet, virement. Ex. : 1234567 |
| Banque émettrice | saisie | Même banque + même numéro de chèque = doublon détecté. Ex. : Banque X |
| Date d'échéance | saisie | Pour les chèques post-datés et effets. Ex. : 30/11/2026 |
| Statut | saisie | Encaissé = crédit vu sur le relevé bancaire. Ex. : Reçu |
| Date d'encaissement | saisie | Date du crédit en banque (ou de la remise des espèces à la direction). |
| Factures / BL concernés | saisie | Ou « acompte » si pas encore de facture. Ex. : VTE-2026-00123 |
| Type | saisie | Ex. : Paiement |
| Saisi par | saisie | Ex. : initiales |
| Observations | saisie |  |
| Doublon ? | formule | Alerte rouge si même numéro et même banque. |
| Alerte échéance | formule | Prévenir la direction si échéance passée et non encaissé. |

## Onglet « Echeancier »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| Client | saisie | Ex. : Client Exemple SARL |
| Réf. accord / facture | saisie | Ex. : ECH-2026-007 |
| N° d'échéance | saisie | Ex. : 1/3 |
| Date d'échéance | saisie | Ex. : 30/11/2026 |
| Montant prévu | saisie | Ex. : 2624 |
| Nature | saisie | Ex. : Chèque |
| Moyen prévu | saisie | Ex. : Chèque |
| Statut | saisie | Ex. : À venir |
| Date dernière relance | saisie |  |
| Montant reçu | saisie | Montant effectivement encaissé pour cette échéance. |
| Reste | formule | Ex. : 2624 |
| Jours de retard | formule | Calculé par rapport à la date du jour. Ex. : 0 |
| Observations | saisie |  |

## Onglet « Soldes_Clients »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| Client | formule | Calculé automatiquement à partir de Ventes, Encaissements et Echeancier. La liste des clients vient de l'onglet Listes. |
| Facturé TTC | formule | Calculé automatiquement à partir de Ventes, Encaissements et Echeancier. La liste des clients vient de l'onglet Listes. |
| Encaissé (crédité) | formule | Calculé automatiquement à partir de Ventes, Encaissements et Echeancier. La liste des clients vient de l'onglet Listes. |
| Chèques en cours (reçus / déposés) | formule | Calculé automatiquement à partir de Ventes, Encaissements et Echeancier. La liste des clients vient de l'onglet Listes. |
| Chèques impayés | formule | Calculé automatiquement à partir de Ventes, Encaissements et Echeancier. La liste des clients vient de l'onglet Listes. |
| Reste dû | formule | Calculé automatiquement à partir de Ventes, Encaissements et Echeancier. La liste des clients vient de l'onglet Listes. |
| Reste dû après chèques en cours | formule | Calculé automatiquement à partir de Ventes, Encaissements et Echeancier. La liste des clients vient de l'onglet Listes. |
| Échéances en retard (reste) | formule | Calculé automatiquement à partir de Ventes, Encaissements et Echeancier. La liste des clients vient de l'onglet Listes. |

## Onglet « Synthese_Mensuelle »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| Mois | formule | Totaux par mois (année dans Parametres). |
| Libellé | formule | Totaux par mois (année dans Parametres). |
| Volume livré (m³) | formule | Totaux par mois (année dans Parametres). |
| Facturé HT | formule | Totaux par mois (année dans Parametres). |
| TVA | formule | Totaux par mois (année dans Parametres). |
| Facturé TTC | formule | Totaux par mois (année dans Parametres). |
| Encaissé (crédité) | formule | Totaux par mois (année dans Parametres). |


# FOURNISSEURS_2026.xlsx

## Onglet « Achats »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| N° BC | saisie | Bon de commande fournisseur numéroté. Ex. : ACH-2026-00031 |
| Date | saisie | Ex. : 14/11/2026 |
| Fournisseur | saisie | Ex. : Fournisseur Exemple SA |
| Catégorie | saisie | Ex. : Ciment |
| Désignation | saisie | Ex. : Ciment CPJ en vrac |
| N° BL fournisseur | saisie | Ex. : BLF-98765 |
| N° facture fournisseur | saisie | Ex. : F-2026-555 |
| Centrale destinataire | saisie | Un BL livré ailleurs que dans une de nos centrales est une alerte. Ex. : Centrale Tétouan |
| Quantité (selon BL) | saisie | Ex. : 30 |
| Unité | saisie | Ex. : t |
| Prix unitaire HT | saisie | Ex. : 1200 |
| Montant HT | formule | Ex. : 36000 |
| TVA | formule | Ex. : 7200 |
| Montant TTC | formule | Ex. : 43200 |
| Quantité reçue (centrale) | saisie | Mesurée à la réception par le chef de centrale. Ex. : 29.8 |
| Écart quantité | formule | Reçu − BL. Tout écart ≠ 0 doit être expliqué. Ex. : -0.2 |
| Statut | saisie | Ex. : Reçu |
| Observations | saisie |  |
| Saisi par | saisie | Ex. : initiales |

## Onglet « Paiements »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| N° paiement | saisie | Ex. : PAY-2026-012 |
| Date d'émission | saisie | Ex. : 16/11/2026 |
| Fournisseur | saisie | Ex. : Fournisseur Exemple SA |
| Mode | saisie | Ex. : Chèque |
| N° chèque / réf. virement | saisie | Ex. : 7654321 |
| Banque | saisie | Ex. : Banque X |
| Montant | saisie | Ex. : 43200 |
| Date d'échéance (chèque post-daté) | saisie |  |
| Statut | saisie | Débité = vu sur le relevé bancaire. Ex. : Préparé |
| Factures payées | saisie | Ex. : F-2026-555 |
| Préparé par | saisie | Ex. : initiales |
| Validé par (direction) | saisie | Obligatoire avant « Signé », « Remis » ou « Débité ». |
| Date de débit | saisie |  |
| Observations | saisie |  |
| Doublon ? | formule | Même numéro + même banque. |
| Alerte | formule | Aucun paiement sans validation de la direction. |

## Onglet « Echeancier_Fournisseurs »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| Fournisseur | saisie | Ex. : Fournisseur Exemple SA |
| Réf. facture | saisie | Ex. : F-2026-555 |
| Date facture | saisie | Ex. : 14/11/2026 |
| Date d'échéance | saisie | Ex. : 14/12/2026 |
| Montant dû | saisie | Ex. : 43200 |
| Mode prévu | saisie | Ex. : Chèque |
| Statut | saisie | Ex. : À payer |
| Date de paiement | saisie |  |
| Montant payé | saisie |  |
| Reste | formule | Ex. : 43200 |
| Jours avant échéance | formule | Négatif = échéance dépassée. Ex. : 29 |
| Observations | saisie |  |

## Onglet « Soldes_Fournisseurs »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| Fournisseur | formule | Calculé automatiquement à partir de Achats et Paiements. |
| Achats TTC | formule | Calculé automatiquement à partir de Achats et Paiements. |
| Payé (débité) | formule | Calculé automatiquement à partir de Achats et Paiements. |
| Paiements en cours (signés / remis) | formule | Calculé automatiquement à partir de Achats et Paiements. |
| Reste dû | formule | Calculé automatiquement à partir de Achats et Paiements. |
| Reste dû après paiements en cours | formule | Calculé automatiquement à partir de Achats et Paiements. |

## Onglet « Synthese_Mensuelle »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| Mois | formule | Totaux par mois. |
| Libellé | formule | Totaux par mois. |
| Achats HT | formule | Totaux par mois. |
| TVA | formule | Totaux par mois. |
| Achats TTC | formule | Totaux par mois. |
| Payé (débité) | formule | Totaux par mois. |


# TRESORERIE_2026.xlsx

## Onglet « Caisse »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| Date | saisie | Ex. : 15/11/2026 |
| N° pièce | saisie | Ex. : ENC-2026-046 |
| Libellé | saisie | Ex. : Encaissement Client Exemple SARL |
| Entrée | saisie | Ex. : 2000 |
| Sortie | saisie |  |
| Solde | formule | Solde cumulé après chaque ligne. Ex. : 2000 |
| Catégorie | saisie | Ex. : Encaissement client |
| Justificatif (N° pièce) | saisie | Ex. : ENC-2026-046 |
| Saisi par | saisie | Ex. : initiales |
| Vérifié par | saisie |  |

## Onglet « Comptage_caisse »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| Date du comptage | saisie | Ex. : 14/11/2026 |
| Solde théorique | formule | Calculé depuis l'onglet Caisse. Ex. : 2000 |
| Comptage réel | saisie | Compté à deux personnes. Ex. : 2000 |
| Écart | formule | Tout écart ≠ 0 est expliqué par écrit et signalé à la direction. Ex. : 0 |
| Compté par | saisie | Ex. : initiales |
| Contrôlé par | saisie | Ex. : initiales |
| Visa direction | saisie |  |
| Observations | saisie |  |

## Onglet « Rapprochement »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| Banque | saisie | Ex. : Banque X |
| Mois (AAAA-MM) | saisie | Ex. : 2026-11 |
| Solde du relevé (fin de mois) | saisie | Ex. : 100000 |
| + Encaissements enregistrés non encore crédités | saisie | Ex. : 7872 |
| − Chèques émis non encore débités | saisie | Ex. : 43200 |
| Solde théorique | formule | = relevé + encaissements non crédités − chèques non débités. Ex. : 64672 |
| Solde comptable (selon nos écritures) | saisie | Ex. : 64672 |
| Écart | formule | Doit être 0. Sinon, enquêter avant de valider. Ex. : 0 |
| Préparé par | saisie | Ex. : initiales |
| Validé par (direction) | saisie |  |
| Date de validation | saisie |  |
| Observations | saisie |  |


# CHARGES_2026.xlsx

## Onglet « Charges »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| N° | saisie | Ex. : CHG-2026-0087 |
| Date | saisie | Ex. : 05/11/2026 |
| Catégorie | saisie | Ex. : Eau et électricité |
| Sous-catégorie | saisie | Ex. : Électricité |
| Bénéficiaire | saisie | Ex. : Fournisseur d'énergie |
| Description | saisie | Ex. : Facture octobre |
| Site | saisie | Ex. : Bureau |
| Montant HT | saisie | Ex. : 1000 |
| TVA | saisie | Ex. : 200 |
| Montant TTC | formule | Ex. : 1200 |
| Mode de paiement | saisie | Ex. : Virement |
| N° pièce | saisie | Ex. : F-0012345 |
| Pièce reçue ? | saisie | Ex. : Oui |
| Statut | saisie | Ex. : Payé |
| Saisi par | saisie | Ex. : initiales |
| Observations | saisie |  |

## Onglet « Synthese_Mensuelle »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| Catégorie × mois | formule | Totaux TTC par catégorie et par mois. |


# PERSONNEL_2026_CONFIDENTIEL.xlsx

## Onglet « Salaries »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| Matricule | saisie | Ex. : S001 |
| Nom et prénom | saisie | Ex. : Nom Exemple |
| Poste | saisie | Ex. : Conducteur de toupie |
| Site | saisie | Ex. : Centrale Tétouan |
| Date d'entrée | saisie | Ex. : 01/03/2024 |
| N° CNSS | saisie | Ex. : 123456789 |
| Mode de paiement | saisie | Ex. : Virement |
| Statut | saisie | Ex. : Actif |
| Date de sortie | saisie |  |
| Observations | saisie |  |

## Onglet « Paie »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| Mois (AAAA-MM) | saisie | Ex. : 2026-11 |
| Matricule | saisie | Ex. : S001 |
| Nom | formule | Ex. : Nom Exemple |
| Salaire de base | saisie | Ex. : 3500 |
| Primes | saisie | Ex. : 0 |
| Heures supplémentaires | saisie | Ex. : 0 |
| Retenue CNSS | saisie | Ex. : 0 |
| Retenue AMO | saisie | Ex. : 0 |
| Retenue IR | saisie | Ex. : 0 |
| Avances retenues | saisie | Ex. : 0 |
| Net à payer | formule | = base + primes + heures sup − retenues − avances. Ex. : 3500 |
| Mode de paiement | saisie | Ex. : Virement |
| Date de paiement | saisie |  |
| Preuve (réf. virement / signature) | saisie |  |
| Validé par (direction) | saisie |  |
| Observations | saisie |  |

## Onglet « Avances »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| Date | saisie | Ex. : 10/11/2026 |
| Matricule | saisie | Ex. : S001 |
| Nom | formule | Ex. : Nom Exemple |
| Montant de l'avance | saisie | Ex. : 500 |
| Motif | saisie | Ex. : Frais familiaux |
| Retenue mensuelle prévue | saisie | Ex. : 250 |
| Validé par (direction) | saisie |  |
| Date de validation | saisie |  |
| Observations | saisie |  |

## Onglet « Soldes_Avances »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| Matricule | formule | Calculé automatiquement. |
| Nom | formule | Calculé automatiquement. |
| Total des avances | formule | Calculé automatiquement. |
| Total déjà retenu | formule | Calculé automatiquement. |
| Reste à retenir | formule | Calculé automatiquement. |


# FLOTTE.xlsx

## Onglet « Vehicules »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| Code | saisie | Code court unique. Le recopier dans Listes (Codes véhicules). Ex. : T01 |
| Type | saisie | Ex. : Toupie (malaxeur) |
| Immatriculation | saisie | Ex. : 12345-A-67 |
| Centrale | saisie | Ex. : Centrale Tétouan |
| Marque / modèle | saisie | Ex. : Marque Exemple |
| Année | saisie | Ex. : 2018 |
| Chauffeur / opérateur habituel | saisie | Ex. : Nom Exemple |
| Échéance assurance | saisie | Ex. : 31/12/2026 |
| Échéance visite technique | saisie | Ex. : 30/06/2027 |
| Échéance vignette | saisie | Ex. : 31/01/2027 |
| Alerte assurance | formule |  |
| Alerte visite | formule |  |
| Alerte vignette | formule |  |
| Observations | saisie |  |

## Onglet « Entretien »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| N° intervention / demande | saisie | Ex. : INT-2026-014 |
| Date | saisie | Ex. : 12/11/2026 |
| Véhicule | saisie | Ex. : T01 |
| Type | saisie | Ex. : Réparation |
| Description / panne | saisie | Ex. : Fuite flexible hydraulique |
| Pièces remplacées | saisie | Ex. : Flexible 1 m |
| Coût pièces | saisie | Ex. : 800 |
| Main-d'œuvre | saisie | Ex. : 300 |
| Coût total | formule | Ex. : 1100 |
| Compteur (km) ou heures | saisie | Ex. : 152300 |
| Réalisé par | saisie | Ex. : Interne |
| N° demande de pièces | saisie | Ex. : DP-2026-009 |
| Validé par (direction) | saisie | Obligatoire au-dessus du seuil (onglet Parametres). |
| N° facture / bon de sortie | saisie | Ex. : F-2026-333 |
| Observations | saisie |  |
| Alerte | formule |  |

## Onglet « Carburant »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| Date | saisie | Ex. : 12/11/2026 |
| Véhicule | saisie | Ex. : T01 |
| Litres | saisie | Ex. : 120 |
| Prix / litre | saisie | Ex. : 17 |
| Montant | formule | Ex. : 2040 |
| Compteur (km) ou heures | saisie | Ex. : 152350 |
| N° bon | saisie | Ex. : BC-4455 |
| Source | saisie | Ex. : Station / cuve centrale |
| Saisi par | saisie | Ex. : initiales |
| Observations | saisie |  |


# TABLEAU_DE_BORD_PROPRIETAIRE.xlsx

## Onglet « Tableau_mensuel »

| Colonne | Type | Règle / exemple fictif |
|---|---|---|
| Volume livré (m³) | saisie | Recopier depuis : CLIENTS › Synthese_Mensuelle |
| Facturé TTC | saisie | Recopier depuis : CLIENTS › Synthese_Mensuelle |
| Encaissé (crédité) | saisie | Recopier depuis : CLIENTS › Synthese_Mensuelle |
| Reste à encaisser fin de mois | saisie | Recopier depuis : CLIENTS › Soldes_Clients (total) |
| dont en retard de plus de 30 jours | saisie | Recopier depuis : Échéancier / rapport hebdomadaire |
| Achats TTC | saisie | Recopier depuis : FOURNISSEURS › Synthese_Mensuelle |
| Paiements fournisseurs (débités) | saisie | Recopier depuis : FOURNISSEURS › Synthese_Mensuelle |
| Reste dû aux fournisseurs fin de mois | saisie | Recopier depuis : FOURNISSEURS › Soldes_Fournisseurs (total) |
| Charges TTC | saisie | Recopier depuis : CHARGES › Synthese_Mensuelle (total) |
| Salaires nets payés | saisie | Recopier depuis : PERSONNEL › Paie |
| Solde banques + caisse fin de mois | saisie | Recopier depuis : TRESORERIE |
| Résultat de trésorerie du mois | formule | Encaissé − paiements fournisseurs − charges − salaires. |
| Taux d'encaissement | formule | Encaissé ÷ facturé TTC. |
| Prix moyen TTC par m³ | formule | Facturé TTC ÷ volume. |
