# Pavelski Zope Map

Mapa interativo dos Estados Unidos por `ZIP3`, com:

- cobertura dos 50 estados (fonte OpenDataDE, sem DC);
- contorno de zona por agregacao de ZIP5;
- transparencia por zona ativa;
- destaque automatico para zonas mais populosas;
- rank populacional geral e rank dentro do estado;
- ZIP5 lider (maior populacao) dentro de cada zona;
- cidades exibidas no mapa e busca por estado/ZIP3/cidade.

## Requisitos

- Node.js 18+
- npm

## Como rodar

```bash
cd "/Users/gustavo/Documents/New project/ohio-zip3-map"
npm install
npm run dev
```

Abra:

- http://localhost:8787

## Login (usuario e senha)

O app usa autenticacao HTTP Basic por padrao.

Credenciais padrao local:

- usuario: `pavelski`
- senha: `zope2026`

Para alterar em producao (Railway), configure variaveis de ambiente:

- `APP_USER`
- `APP_PASSWORD`

Para desativar autenticacao (opcional):

- `AUTH_DISABLED=true`

## Scripts

- `npm run prepare-data`: baixa os limites ZIP5 por estado, agrega em zonas `STATE-ZIP3` e gera:
  - `public/data/coverage_zip3.geojson`
  - `public/data/coverage_zip3_zones.json`
  - `public/data/coverage_cities.json`
  - `public/data/coverage_states.json`
- `npm run start`: sobe servidor na porta `8787`
- `npm run dev`: gera dados e sobe servidor

## Definir zonas de trabalho

Edite `public/data/work_zones.json`.

### Exemplo por estado

```json
{
  "name": "Minhas zonas",
  "states": ["PA", "NJ", "NY"]
}
```

### Exemplo por zona especifica (`STATE-ZIP3`)

```json
{
  "name": "Zonas especificas",
  "zones": ["PA-152", "NJ-070", "NY-100"]
}
```

## Fontes de dados

- Limites ZIP/ZCTA: `OpenDataDE/State-zip-code-GeoJSON`
- Cidade/lat/lon/populacao por ZIP: pacote npm `zipcode-detail-lookup`
