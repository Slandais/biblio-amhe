Le projet consiste à créer la bibliographie la plus exhaustive des ouvrages pouvant servir de sources aux AMHE (Arts Martiaux Historiques Européens).

Le projet prend la forme d'un tableau HTML écrit dans le fichier index.html :

- le titre qui contient le titre du livre
- Auteur qui contient le nom du ou des auteurs du livre. Si inconnu alors mettre Anonyme.
- Côte correspond à la côte de concervation dans le musée, par exemple "MS I.33"
- "lien wiki AMHE" : contient uniquement des lien vers le titre wiki.ffamhe.fr, le lien doit mener vers la page qui traite du livre
- "liens" contient d'autre lien web vers d'autres pages qui traitent de ce livre
- numérisation, contient un enum OUI/NONAJOUR/MANQUANTE qui indique si la numérisation du traité est disponible en lien sur Internet. OUI signifie que la numérisation existe et qu'elle est bien en lien sur le wiki AMHE. NONAJOUR signifie que la numérisation existe mais qu'elle n'est pas en lien sur le wiki AMHE. MANQUANTE signifie que la numérisation n'est pas disponible.
- commentaire, une phrase succinte
- date de dernière modification, la date où la ligne du tableau HTML a été modifiée pour la dernière fois

Le tableau HTML doit être trié alphabétiquement sur le titre, et en l'absence de titre sur la côte.

Le contenu du tableau HTML doit être écrit en HTML dans le fichier index.html, il ne faut pas stocker les données en json.

Pour déployer sur vercel, lancer cette commande : npx vercel deploy --prod --scope slandais-projects