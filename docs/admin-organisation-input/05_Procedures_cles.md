# Procédures clés

Version 1 — 15/11/2026 — à valider par la direction. `[X MAD]` et `[N]` : valeurs à fixer par la direction.

## P1. Commande client
1. Le client appelle ou envoie une demande. La responsable note : client, chantier, classe, mode (**goulotte** ou **pompe**), volume, date et heure souhaitées.
2. Vérifier le programme de la centrale (camions, pompe, capacité) et la situation du client (impayés échus ?). Si impayés importants : décision de la direction avant d'accepter.
3. **Confirmer au client par téléphone** (prix par m³ selon la grille et le mode, condition de paiement). Une demande n'est une commande ferme qu'après cette confirmation.
4. Attribuer le numéro de commande ; transmettre au chef de centrale.
5. Prix particulier ou remise : accord écrit de la direction, joint à la commande.

## P2. Encaissement
1. Recevoir le paiement (espèces, chèque, virement, effet). Pour un chèque : vérifier date, ordre, montant en chiffres et lettres, signature, banque.
2. **Photocopier ou scanner le chèque avant tout dépôt.**
3. Saisir dans `Encaissements` le jour même : numéro de pièce `ENC-AAAA-nnn`, client, mode, montant, n° de chèque, banque, échéance, factures ou BL concernés (ou « acompte »).
4. Contrôle du doublon (même numéro de chèque et même banque) : la colonne `Doublon ?` doit rester vide.
5. Espèces : remettre un reçu numéroté au client ; compter devant le client.
6. Remettre à la direction contre signature ; statut « Déposé » lorsque la banque a pris le chèque ; « Encaissé » seulement quand le crédit est vu sur le relevé.
7. Chèque impayé : statut « Impayé » ; avertir la direction le jour même ; ne plus livrer à crédit à ce client sans accord.

## P3. Échéancier client (paiement échelonné, chèques post-datés)
1. Tout accord écrit : client, montant total, nombre d'échéances, dates, moyen. Au-delà de `[X MAD]` ou `[N]` jours : signature de la direction.
2. Une ligne dans `Echeancier` par échéance (par exemple 1/3, 2/3, 3/3).
3. 7 jours avant chaque échéance : rappel au client. Le jour J : vérifier la réception. J+1 : relance (voir P4).

## P4. Relance des impayés (échelle)
| Retard | Action | Qui |
|---|---|---|
| J+1 | Appel courtois au contact du client ; noter la promesse (date, montant) | Responsable |
| J+7 | Deuxième appel + message écrit (relevé joint) | Responsable |
| J+15 | Appel du responsable de l'entreprise cliente ; **prévenir la direction** | Responsable → Direction |
| J+30 | Décision de la direction : suspension des livraisons, mise en demeure, démarche juridique | Direction |
Chaque relance est notée avec la date dans `Echeancier` (colonne `Date relance`).

## P5. Réception fournisseur et rapprochement trois pièces
1. Le chef de centrale réceptionne : quantité réellement reçue (pesée ou comptage) notée sur le BL fournisseur.
2. L'assistante saisit dans `Achats` : BL fournisseur, quantité commandée / livrée / **reçue**.
3. À réception de la facture : comparer BL, réception, facture (quantité et prix).
4. Écart de quantité ou de prix : **signaler le jour même** à la direction ; ne pas payer la partie contestée.
5. Tout BL fournisseur sans réception chez nous, ou livré à une destination qui n'est pas une de nos centrales, est un signal d'alerte à transmettre.

## P6. Paiement fournisseur
1. L'assistante prépare le dossier : facture, BL, bon de commande, rapprochement terminé.
2. La direction vérifie, **valide et signe** le chèque ou le virement.
3. Remplir la souche **avant** de remettre le chèque : montant, bénéficiaire, factures payées.
4. Saisir dans `Paiements` : numéro de chèque, banque, statut, validé par.
5. Statut « Débité » lorsque le relevé le confirme. Archiver la pièce de paiement avec la facture.
6. Changement de RIB ou de bénéficiaire : validation de la direction + rappel du fournisseur sur un numéro déjà connu.

## P7. Dépenses courantes et petite caisse
1. Pas de dépense sans pièce (facture, reçu, ticket) ; une dépense sans pièce est notée « pièce à fournir » avec échéance.
2. Au-delà de `[X MAD]` : accord préalable de la direction.
3. Saisir dans `Charges` (catégorie de la liste) ; payer par chèque ou virement dès que possible plutôt qu'en espèces.

## P8. Paie et avances
1. Fichier **confidentiel**, accès limité à la direction (et au comptable si mandat écrit).
2. Avance : demande écrite du salarié ; validation de la direction ; ligne dans `Avances` avec le plan de retenue.
3. Chaque paiement de salaire : date, mode, signature du salarié ou preuve de virement.

## P9. Correction d'une erreur (on ne supprime rien)
1. Ne jamais effacer la ligne ; ne jamais écraser un montant déjà validé.
2. Saisir une **ligne inverse** (montant négatif ou statut « Annulé ») avec le motif et la référence de la ligne corrigée, puis la ligne correcte.
3. Écrire la correction dans la colonne « Observations » avec la date et les initiales ; informer la direction si le montant dépasse `[X MAD]`.

## P10. Départ ou arrivée d'une personne (accès)
**Arrivée :** compte nominatif dans KAYAS ; accès Drive limité à son poste ; mot de passe personnel ; signature de la charte de confidentialité.
**Départ :** le jour même, la direction fait désactiver les comptes KAYAS, retirer l'accès au Drive, aux e-mails, aux messageries et aux banques ; changer les mots de passe partagés (fournisseurs, portails, boîte commune) ; récupérer clés, cachets et classeurs ; vérifier que les fichiers sont complets avant le départ.
