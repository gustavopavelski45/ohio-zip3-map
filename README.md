# Pavelski Zope Map

Mapa interativo dos Estados Unidos por `ZIP3`, com:

- cobertura dos 50 estados (fonte OpenDataDE, sem DC);
- contorno de zona por agregacao de ZIP5;
- camada opcional de counties para visualizar county, ZIP3 ou ambos, com cor e labels separados;
- transparencia por zona ativa;
- destaque automatico para zonas mais populosas;
- rank populacional geral e rank dentro do estado;
- ZIP5 lider (maior populacao) dentro de cada zona;
- ZIP com mais casas estimadas dentro da zona;
- modo `Mortgage Opportunity` com rank de volume de hipoteca e score de oportunidade;
- modo `Delinquency Proxy` com estimativa de inadimplencia e rank de risco;
- modo `Atraso (CFPB gratis)` com reclamacoes reais de dificuldade de pagamento/servicing e rank por zona;
- modo `30 dias / OT%` com volume operacional por zona e percentual on-time, sem expor codigos de vendor;
- popup resumido opcional com estado, zona, ZIP principal, OT%, volume e county principal;
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

- `npm run prepare-mortgage-data`: gera `public/data/hmda_county_2024.json` a partir do snapshot HMDA oficial (FFIEC/CFPB)
- `npm run prepare-cfpb-data`: gera `public/data/cfpb_mortgage_distress_12m.json` (API publica CFPB)
- `npm run prepare-zone-performance-data -- arquivo.txt`: gera `public/data/zone_performance_30day.json` com apenas zona, volume 30 dias e OT%
- `npm run prepare-county-data`: gera `public/data/coverage_counties.geojson`
- `npm run prepare-data`: baixa os limites ZIP5 por estado, agrega em zonas `STATE-ZIP3` e gera:
  - `public/data/coverage_zip3.geojson`
  - `public/data/coverage_zip3_zones.json`
  - `public/data/coverage_cities.json`
  - `public/data/coverage_states.json`
- `npm run start`: sobe servidor na porta `8787`
- `npm run dev`: gera dados e sobe servidor

Para usar o modo de mortgage com dados reais:

```bash
npm run prepare-mortgage-data
npm run prepare-cfpb-data
npm run prepare-data
```

Opcional: para recalibrar o proxy de inadimplencia sem alterar codigo, defina `DELINQUENCY_BASE_RATE` (ex.: `0.0335` para 3.35%) antes de rodar `prepare-data`.

Opcional: ajuste a janela do CFPB gratuito com:

- `CFPB_LOOKBACK_MONTHS` (padrao: `12`)
- `CFPB_DATE_RECEIVED_MIN` (sobrescreve data minima)
- `CFPB_ISSUES` (padrao: `Struggling to pay mortgage`; separado por `|`)

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
- Counties: `plotly/datasets` (`geojson-counties-fips.json`)
- Cidade/lat/lon/populacao por ZIP: pacote npm `zipcode-detail-lookup`
- Mortgage originations: HMDA snapshot publico (`FFIEC/CFPB`)
- Atraso (gratis): `CFPB Consumer Complaint Database API` (produto Mortgage)
- Performance operacional: relatorio interno sanitizado em `zone_performance_30day.json`
