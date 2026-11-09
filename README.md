# Oficina Tabner

Tablero en vivo del equipo. Solo lee `/workspace/tabner-ops/ESTADO.md`; no lo modifica.

- Tablero: https://jzalaya.github.io/tabner-oficina/
- JSON: https://jzalaya.github.io/tabner-oficina/status.json

Arranque (en el ordenador de los bots, donde está el workspace):

```
node /workspace/tabner-oficina/publish-estado.mjs
```

Lee el archivo cada 45 segundos y publica el JSON solo si ha cambiado.
