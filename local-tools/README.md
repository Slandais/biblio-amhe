# Outils locaux

Ces scripts servent a recuperer du contenu sur Internet pour preparer l'alimentation de `index.html`.

Ils sont volontairement exclus du deploiement Vercel via `.vercelignore`.

## Recuperer une source

```powershell
npm run fetch:source -- --url "https://archive.org/stream/bub_gb_Djk-AAAAYAAJ/bub_gb_Djk-AAAAYAAJ_djvu.txt"
```

Le script :

- telecharge la source ;
- applique une normalisation pour certaines URLs, notamment Archive.org ;
- sauvegarde la reponse brute et une version texte exploitable dans `local-data/sources/<slug>/`.
