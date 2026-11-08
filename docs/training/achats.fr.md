# Fiche d'exercices — Bureau achats

Données **fictives**. Compte à utiliser : « Bureau achats » (achats@formation.kayas.invalid). Les mots de passe ne figurent dans aucune fiche : ils sont remis en main propre.

## À essayer
Ton menu (profil bureau achats, sans montants) : *Achats* → Nouvel achat, Facture fournisseur à saisir, Fournisseurs ; *Production* → Réceptions, Chargements, Annulations. Tu n'as **pas** les écrans *Achats* (liste), *Factures fournisseurs* (liste) ni *Stock* : ils sont réservés au propriétaire, à l'administrateur et aux chefs de centrale.
1. **Livraison à recevoir** : ouvre *Production → Réceptions* ; l'arrivage de ciment (30 t) de Tétouan est en attente. Documente la réception avec les détails du fournisseur une fois que le chef de centrale a compté l'arrivage (c'est lui qui confirme l'arrivée). Résultat : le stock de ciment augmente.
2. **Commander pour stock bas** : le chef de centrale de Tétouan voit une alerte de ciment bas dans son écran *Stock* (tu n'as pas cet écran : il te la signale). Crée l'achat : *Achats → Nouvel achat*, ciment, Tétouan. Résultat : un code ACH-… ; l'alerte reste tant que la livraison n'est pas reçue.
3. **Facture fournisseur** : *Achats → Facture fournisseur à saisir* : saisis la facture du fournisseur « Ciment Démo ». Tu ne vois ni la liste des factures ni leur rapprochement, et tu ne peux pas approuver : c'est le propriétaire.

Captures : `docs/training/screens/achats-*.png` (jeu de données fictif).
