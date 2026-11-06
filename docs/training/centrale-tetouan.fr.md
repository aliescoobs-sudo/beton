# Fiche d'exercices — Chef de centrale Tétouan

Données **fictives**. Compte à utiliser : « Chef de centrale Tétouan » (centrale-tetouan@formation.beton.invalid). Les mots de passe ne figurent dans aucune fiche : ils sont remis en main propre.

## À essayer
1. **Commandes du jour à répartir** : ouvre *Répartition*. Trois commandes ont déjà leurs rotations en séquence sur trois camions et trois chauffeurs ; une commande (16 m³) n'est pas planifiée : ajoute-la à un camion et enregistre. Résultat : le chauffeur voit une rotation de plus sur son téléphone.
2. **Camions et chauffeurs disponibles** : sur la même page, vois les camions (un en panne si tu en déclares un) et les chauffeurs ; changer de chauffeur demande un motif (tracé).
3. **Alerte de stock bas** : *Stock* montre le ciment sous son seuil. Résultat attendu : une ligne rouge ; le bureau achats voit la même alerte.
4. **Créneau de production de l'après-midi** : ajoute la rotation non planifiée en dernière position d'un camion : son départ prévu se décale en conséquence.

Captures : `docs/training/screens/centrale-tetouan-*.png` (jeu de données fictif).

## Suivi des rotations (retards)
5. **Tableau par camion** : sous *Répartition*, le tableau « Suivi des rotations » montre chaque camion (disponible, au chargement, en route, retour en cours), l'heure prévue, le retour recalculé et l'écart de chaque rotation. Un camion est **déjà en retard** : son statut est « Retard prévu » et la rotation suivante est nommée avec les minutes de retard.
6. **Réaffecter ou reporter** : sur la rotation concernée, *Réaffecter* (autre camion, autre chauffeur, motif obligatoire) ou *Reporter* (motif obligatoire). Résultat : le planning change, le chauffeur voit la modification, et l'action est enregistrée avec son motif. Aucun message n'est envoyé au client.
7. **Durées estimées** : dans *Durées estimées*, vois d'où vient chaque durée (historique, valeur imposée, plan) et impose une valeur pour une route avec un motif (par exemple Oued Laou, trajet aller).
8. **Statistiques** : *Retards des 14 derniers jours* donne les moyennes par étape, route, chauffeur et jour, à titre d'information (pas de classement).
