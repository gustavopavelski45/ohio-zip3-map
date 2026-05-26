# ZIP3 Multi-State Coverage Map

Mapa interativo por `ZIP3` com:

- cobertura multiestado (OH, PA, MI, NJ, NY, NH, NC, SC, CT);
- cobertura multiestado (OH, PA, MI, NJ, NY, NH, NC, SC, CT, GA, DE, MD, CA, FL, VA, KY);
- zonas ativas com transparência;
- destaque automático para zonas mais populosas;
- cidades visíveis no mapa;
- busca por estado, ZIP3 e cidade.

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

## Scripts

- `npm run prepare-data`: baixa os limites ZIP por estado, agrega em zonas `STATE-ZIP3` e gera:
  - `public/data/coverage_zip3.geojson`
  - `public/data/coverage_zip3_zones.json`
  - `public/data/coverage_cities.json`
  - `public/data/coverage_states.json`
- `npm run start`: sobe servidor estático na porta `8787`
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

### Exemplo por zona específica (`STATE-ZIP3`)

```json
{
  "name": "Zonas específicas",
  "zones": ["PA-152", "NJ-070", "NY-100"]
}
```

### Compatibilidade com formato antigo

```json
{
  "zip3": ["432", "441"]
}
```

## Fontes de dados

- Limites ZIP/ZCTA: `OpenDataDE/State-zip-code-GeoJSON`
- Cidade/lat/lon/população por ZIP: pacote npm `zipcode-detail-lookup`

## Observação técnica

As geometrias exibidas no mapa são zonas `ZIP3` simplificadas a partir de ZCTA para manter performance visual em vários estados.
