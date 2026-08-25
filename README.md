# action-zenifra

Esta GitHub Action publica uma imagem na [Zenifra](https://www.zenifra.com). Ela também pode manter um **Ambiente de Preview** temporário para cada pull request, com uma chave estável, URL própria, expiração e remoção idempotente.

This GitHub Action deploys an image to [Zenifra](https://www.zenifra.com). It can also manage a temporary **Preview Environment** for each pull request, with a stable key, its own URL, expiration, and idempotent deletion.

## Uso legado / Legacy usage

Quando `PREVIEW` é omitido ou definido como `false`, a Action mantém o comportamento legado: atualiza a imagem do projeto principal.

When `PREVIEW` is omitted or set to `false`, the Action keeps its legacy behavior and updates the main project image.

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to Zenifra
        uses: zenifra/action-zenifra-deploy@main
        with:
          PROJECT_ID: ${{ vars.ZENIFRA_PROJECT_ID }}
          IMAGE: registry.example.com/my-app:${{ github.sha }}
          API_KEY: ${{ secrets.ZENIFRA_API_KEY }}
```

> **Segurança / Security:** use `API_KEY` somente por meio de um secret do GitHub. A Action não publica a chave, valores de variáveis de ambiente ou credenciais nos logs, outputs ou no Job Summary.

## Inputs / Entradas

| Input | Descrição / Description | Obrigatório / Required | Padrão / Default |
| :--- | :--- | :---: | :---: |
| `PROJECT_ID` | ID do projeto principal / Main project ID | Sim / Yes | — |
| `API_KEY` | Chave de API do projeto / Project API key | Sim / Yes | — |
| `API_BASE_URL` | Origem da API; permite validar a Action contra um ambiente de teste / API origin; allows validation against a test environment | Não / No | `https://api.zenifra.com` |
| `IMAGE` | Imagem a publicar. Obrigatória em deploy normal e `upsert`; dispensada em `delete` / Image to deploy. Required for standard deployments and `upsert`; not required for `delete` | Condicional / Conditional | — |
| `PREVIEW` | Ativa Ambientes de Preview / Enables Preview Environments | Não / No | `false` |

| `PREVIEW_KEY` | Chave estável. Em `pull_request`, deriva `pr-<number>` quando omitida / Stable key. On `pull_request`, derives `pr-<number>` when omitted | Condicional / Conditional | — |
| `PREVIEW_TTL` | Duração entre `1h` e `168h` / Lifetime from `1h` to `168h` | Não / No | `24h` |
| `PREVIEW_ACTION` | `auto`, `upsert` ou `delete` / `auto`, `upsert`, or `delete` | Não / No | `auto` |
| `WAIT_TIMEOUT` | Espera entre `1s` e `15m` / Wait from `1s` to `15m` | Não / No | `10m` |

Booleanos aceitos: `true` e `false` (sem distinção de maiúsculas/minúsculas). Durações usam um número inteiro seguido de `s`, `m`, `h` ou `d`.

Accepted booleans are `true` and `false` (case-insensitive). Durations use a whole number followed by `s`, `m`, `h`, or `d`.

## Validating a feature branch against a test API / Validando uma branch contra uma API de teste

The Action can be referenced from a feature branch in a private test workflow. Set `API_BASE_URL` to the test API origin, use a project and API key created only for that environment, and keep the key in a GitHub secret. The default remains the production API, so existing workflows do not change.

A Action pode ser referenciada por uma branch de feature em um workflow privado de teste. Defina `API_BASE_URL` para a origem da API de teste, use um projeto e uma API Key exclusivos desse ambiente e mantenha a chave em um secret do GitHub. O padrão continua sendo a API de produção, portanto workflows existentes não mudam.

```yaml
name: Validate Preview Action

on:
  workflow_dispatch:

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - name: Create test preview
        id: preview
        uses: zenifra/action-zenifra-deploy@feat/preview-environments
        with:
          API_BASE_URL: https://api.example.test
          PROJECT_ID: ${{ vars.TEST_PROJECT_ID }}
          API_KEY: ${{ secrets.TEST_PROJECT_API_KEY }}
          PREVIEW: true
          PREVIEW_KEY: action-test-${{ github.run_id }}
          PREVIEW_ACTION: upsert
          IMAGE: registry.example.test/app:${{ github.sha }}
          PREVIEW_TTL: 1h
          WAIT_TIMEOUT: 15m

      - name: Remove test preview
        if: always()
        uses: zenifra/action-zenifra-deploy@feat/preview-environments
        with:
          API_BASE_URL: https://api.example.test
          PROJECT_ID: ${{ vars.TEST_PROJECT_ID }}
          API_KEY: ${{ secrets.TEST_PROJECT_API_KEY }}
          PREVIEW: true
          PREVIEW_KEY: action-test-${{ github.run_id }}
          PREVIEW_ACTION: delete
```

The API base URL must be HTTPS, except for localhost test runners, and must contain only the API origin without credentials, query parameters, fragments, or paths.

A origem da API deve usar HTTPS, exceto em runners locais apontando para localhost, e deve conter somente a origem da API, sem credenciais, parâmetros de query, fragmentos ou caminhos.

## Ambiente de Preview em pull requests / Pull request Preview Environment

A configuração recomendada usa os eventos `opened`, `synchronize`, `reopened` e `closed`. Com `PREVIEW_ACTION: auto`, eventos `opened`, `synchronize` e `reopened` fazem `upsert`; `closed` faz `delete`.

The recommended configuration uses `opened`, `synchronize`, `reopened`, and `closed`. With `PREVIEW_ACTION: auto`, `opened`, `synchronize`, and `reopened` perform an `upsert`; `closed` performs a `delete`.

```yaml
name: Preview Environment

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - name: Manage Preview Environment
        uses: zenifra/action-zenifra-deploy@main
        with:
          PROJECT_ID: ${{ vars.ZENIFRA_PROJECT_ID }}
          API_KEY: ${{ secrets.ZENIFRA_API_KEY }}
          IMAGE: registry.example.com/my-app:${{ github.event.pull_request.head.sha }}
          PREVIEW: true

          PREVIEW_TTL: 24h
```

Em um pull request, a chave padrão é `pr-<number>`, portanto novas execuções atualizam o mesmo Ambiente de Preview. Fora de um evento `pull_request`, informe `PREVIEW_KEY` explicitamente.

For a pull request, the default key is `pr-<number>`, so later runs update the same Preview Environment. Outside a `pull_request` event, provide `PREVIEW_KEY` explicitly.

A remoção não precisa de `IMAGE`. Para um workflow manual, use uma chave explícita e escolha a ação desejada:

A delete does not require `IMAGE`. For a manual workflow, use an explicit key and select the desired action:

```yaml
name: Preview cleanup

on:
  workflow_dispatch:
    inputs:
      preview_action:
        required: true
        default: delete
        type: choice
        options: [upsert, delete]

jobs:
  preview:
    runs-on: ubuntu-latest
    steps:
      - name: Manage Preview Environment
        uses: zenifra/action-zenifra-deploy@main
        with:
          PROJECT_ID: ${{ vars.ZENIFRA_PROJECT_ID }}
          API_KEY: ${{ secrets.ZENIFRA_API_KEY }}
          PREVIEW: true
          PREVIEW_KEY: manual-preview
          PREVIEW_ACTION: ${{ inputs.preview_action }}
          IMAGE: ${{ inputs.preview_action == 'upsert' && 'registry.example.com/my-app:manual' || '' }}
```

O Preview sempre usa o mesmo plano do projeto principal. `PREVIEW_TTL` controla somente a duração; não existe seleção de plano separado para o Preview.

The Preview always uses the main project's plan. `PREVIEW_TTL` controls only the lifetime; there is no separate Preview plan selection.

Todo Preview herda os ENVs configurados pelo usuário dentro da Zenifra; os valores não atravessam a Action e nunca são mostrados. Esses ENVs podem apontar para os mesmos bancos, filas, buckets ou serviços do projeto principal. O storage do preview começa vazio e isolado; dados, domínios personalizados e comandos customizados da imagem não são copiados.

Every Preview inherits user-configured ENVs inside Zenifra; values never pass through the Action and are never displayed. Those ENVs may point to the same databases, queues, buckets, or services as the main project. Preview storage starts empty and isolated; data, custom domains, and custom image commands are not copied.

## Outputs / Saídas

Os outputs de preview são definidos depois que a operação chega a um estado terminal. Em `delete`, `preview_url` e `expires_at` podem ficar vazios.

Preview outputs are set only after the operation reaches a terminal state. For `delete`, `preview_url` and `expires_at` may be empty.

| Output | Descrição / Description |
| :--- | :--- |
| `project_id` | ID do projeto principal / Main project ID |
| `preview_key` | Chave estável do Preview / Stable Preview key |
| `preview_ttl` | Duração configurada do Preview; vazio em `delete` / Configured Preview lifetime; empty for `delete` |
| `preview_id` | ID do Ambiente de Preview / Preview Environment ID |
| `preview_url` | URL própria do preview, quando disponível / Preview URL, when available |
| `expires_at` | Expiração / Expiration timestamp |
| `operation_id` | ID da operação assíncrona / Async operation ID |
| `preview_status` | Estado terminal / Terminal status (`available` ou `deleted`) |

Quando um Preview fica disponível, o log do job informa o `PROJECT_ID`, a chave, o status, a URL retornada pela API, o TTL configurado, a data de expiração e o ID da operação. A mesma informação fica no Job Summary.

When a Preview becomes available, the job log reports the `PROJECT_ID`, key, status, API URL, configured TTL, expiration time, and operation ID. The same information is included in the Job Summary.

A Action aguarda a conclusão com polling limitado. Se o tempo acabar ou o estado final não for compatível com a ação solicitada, o job falha com uma mensagem pública e segura. Um `delete` de um preview já ausente é considerado sucesso.

The Action waits for completion with bounded polling. If the wait expires or the terminal state is incompatible with the requested action, the job fails with a safe public message. Deleting an already missing preview is treated as success.

## License

MIT
