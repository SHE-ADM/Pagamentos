# Camada de dados da Next API — CRUDs, auth e visibilidade

Extraído do `CLAUDE.md` em 2026-08-04. Guarda o **catálogo completo**: cada CRUD (rotas, status
codes, schemas Zod, particularidades de cada cadastro), o modelo de papéis, a auditoria de autor e
o desenho de anexos — com o raciocínio e os casos reais por trás de cada decisão.

Os **invariantes de segurança e de contrato** continuam resumidos no `CLAUDE.md`, na Regra
mandatória 3 ("REST no backend") — ele é carregado automaticamente em toda sessão, este arquivo
não. **Ao mexer na Next API, leia os dois.**

Texto verbatim, na ordem original.

---
**CRUD de fornecedores (`apps/api-backend/lib/suppliers.ts` + `app/api/suppliers/**`):** primeiro
CRUD completo da Next API (Repository → Service → Route, escrita via `getSupabaseAdmin`).
`GET /api/suppliers` (paginado `page`/`limit`≤100 + `search` por nome/CNPJ/CPF/4 e-mails via
`ilike`, índices trgm da migration 029) · `GET/PATCH/DELETE /api/suppliers/:sk` (por
`sk_supplier`) · `POST /api/suppliers`. Validação Zod em `@sheild/shared`
(`supplierCreateSchema`/`supplierUpdateSchema` — CNPJ/CPF com strip de máscara; ao menos um
identificador, espelhando `chk_supplier_has_identifier`; **classificação default
`cost_center_id`/`chart_account_id`** editável — `int().min(0)`, `0` = "não informado"). O form
(`SupplierForm`) traz **Plano de contas** e **Centro de custo** em CASCATA INVERTIDA
(`ChartAccountSelect`=plano por descrição → `CostCenterSelect`=os centros que compõem o plano;
ver "Lookups de classificação contábil"); o payload sempre envia os dois ids (`0` quando vazio,
cobrindo limpar na edição), e `SuppliersPage.openEdit` busca o fornecedor completo (`getSupplier`,
com embeds) para rotular os selects. `DELETE` é **soft delete**
(`deleted_at`, migration 045) e **bloqueia com 409** quando há contas vinculadas
(`financial_account_control.sk_supplier`) — fornecedor é PRESERVADO, nunca hard delete.
`sk_supplier`/`supplier_id` nunca entram no corpo (gerados pelo banco + trigger
`trg_supplier_mirror_id`). Status: `201` criação · `409` UNIQUE (23505) de CNPJ/CPF · `404` ·
`422` Zod · `400` sk inválido. **Ordenação `?sort=name`** (opcional): ordena por `trade_name` asc —
usado pelo **lookup de fornecedor** do modal de contas (`SupplierSelect`, ordem alfabética global);
**sem `sort`** o padrão é `sk_supplier` desc (página `/fornecedores`). Spec/template em
`docs/prompts/api-supplier-crud-spec.md`. **`/fornecedores` (`SuppliersPage`):** a edição abre
**apenas pelo botão de lápis** (coluna "Ações") — `onRowClick` do grid é no-op; clicar na linha
não abre o modal. **Colunas do grid** (`getSupplierColumns`): Razão social · Nome fantasia ·
**CNPJ / CPF** (uma única coluna — CNPJ se houver, senão CPF; helper `supplierDoc`) · E-mail ·
**Centro de custo** · **Plano de contas** (classificação default, `código — descrição`; id 0 →
"—") · Ações. Para exibir as descrições da classificação, o `findAll` da lista
(`GET /api/suppliers`) passou a trazer os **embeds** `cost_center`/`chart_account`
(`SELECT_WITH_CLASSIFICATION`) — antes só o `GET /:sk` os trazia. As duas colunas de classificação
são **ordenáveis server-side pela FK própria** (`sort=cost_center_id`/`chart_account_id`, no
allowlist `SORTABLE_COLUMNS`); CNPJ/CPF ordena por `cnpj`.

**CRUD de contas (`apps/api-backend/lib/contas.ts` + `app/api/contas/**`):** CRUD da tabela
principal `financial_account_control` (PK = **`id`**, não `sk_*`; fornecedor pela FK obrigatória
`sk_supplier`). `GET /api/contas` (paginado + `search` por fornecedor/nº doc/assunto/remetente,
JOIN `supplier`, exclui `cancelado` por padrão) · `GET/PATCH/DELETE /api/contas/:id` · `POST /api/contas`.
**Remoção PADRÃO = `PATCH { status_id: <id do cancelado = 9> }`** (preservação). **`DELETE` = HARD
DELETE físico, restrito ao GRUPO ADMINISTRADOR** (`requireAdminGroup` → **403** fora do grupo;
`contaService.remove` → `contaRepository.hardDelete`) — exceção deliberada à preservação (pedido do
usuário). **Verificado no banco (não regredir):** a ÚNICA FK que referencia `financial_account_control`
é `financial_account_attachment.account_id` **ON DELETE CASCADE** (as linhas de anexo caem junto) — não
há FK RESTRICT/NO ACTION, e **não há trigger de DELETE** (os 4 triggers são só INSERT/UPDATE), então o
delete é limpo e completo. Os objetos no bucket viram órfãos (limpos por `purge_orphan_attachments`).
Status: `404` (inexistente) · `409` (FK RESTRICT — defensivo, hoje inalcançável) · `500` NÃO vaza
detalhe (`ContaServiceError(msg,500)` → `failFromError` genérico + log). **`canSeeConta` é
DELIBERADAMENTE omitido** (diferente de GET/PATCH): o propósito é o Administrador excluir QUALQUER conta
— aplicar `canSeeConta` acoplaria a exclusão à visibilidade e BLOQUEARIA um admin restrito; o gate de
grupo é o modelo correto (admin vê tudo é a invariante single-org). UI: botão **"Excluir conta"** no
painel de detalhe de `/consulta`, só para o grupo Administrador (`isAdminGroup` do `AuthContext`), com
**confirmação inline** (irreversível); remove a linha + ajusta `total`/cards ("Valor total"/"Total de
registros" só descontam quando a conta NÃO era cancelada — esses cards excluem cancelado) + `refreshStats`.
O gate de UI é cosmético — a autorização é imposta no servidor. Testes: `lib/contas.test.ts`
(`remove` 404/409/500), `app/api/contas/[id]/route.test.ts` (DELETE 403/400/200/404),
`Consulta.test.tsx` (botão só p/ admin + fluxo de confirmação → `deleteConta`).
Validação Zod em `@sheild/shared` — `financialAccountControlCreateSchema` (criação manual exige
`sk_supplier` + `amount`>0; demais campos opcionais, o banco aplica DEFAULT/NULL; **`status_id` é
OMITIDO do create** — a conta nasce no DEFAULT 3 do banco (`a vencer`) e a trigger recalcula
`a vencer`/`vencido` por vencimento, então o cliente NÃO cria conta já em estado fechado) e
`financialAccountControlUpdateSchema` (partial — aceita `status_id`; a baixa/cancelamento é feita
depois via PATCH). `status_id`/`sk_company`/`created_at`/`updated_at` são derivados (trigger) ou
controlados — só `status_id` entra no corpo de PATCH (situação), nunca no de criação. Status: `201` · `409` (23505) · `404` · `422` ·
`400` id inválido. Frontend: **página `/contas`** (lançamento rápido — `pages/ContasNovaPage.tsx`
com o card centralizado `mx-auto` + `organisms/ContaForm.tsx`) e **edição da conta em `/consulta`
pelo botão "Editar conta" do painel de detalhe** (abre o modal `ContaForm` → `PATCH /api/contas/:id`).
A antiga coluna **"Ações"** do grid (botão lápis por linha) foi **REMOVIDA** — o grid não tem mais
coluna de ação; clicar na linha abre o detalhe e a edição parte de lá. Fornecedor via
**react-select** (`molecules/SupplierSelect.tsx` — `AsyncCreatableSelect`: busca + cria fornecedor
inline via `POST /api/suppliers`); **tipo de documento e tipo de pagamento** são `<select>` de enum
(valores pré-definidos, obrigatórios, **ordenados alfabeticamente** — `DOCUMENT_TYPE_OPTIONS`/
`PAYMENT_METHOD_OPTIONS` em `ContaForm`). **Classificação contábil** via dois lookups react-select
em **CASCATA INVERTIDA (Plano → Centro)**: **Plano de contas** (`molecules/ChartAccountSelect.tsx`,
por descrição) PRIMEIRO e **Centro de custo** (`molecules/CostCenterSelect.tsx`, os centros que
compõem o plano) DEPOIS: ver "Lookups de classificação contábil (cascata)".
**Empresa pagadora (`sk_company`) é ESCOLHIDA no form** (`LabeledSelect` "Empresa", logo após o
Fornecedor): 1=OTIMOTEX / 2=LEBIANCO, opções via `GET /api/companies` (`companyService` em
`lib/lookups.ts`, molde do `statusService`; cliente `listCompanies` em `services/lookups.ts`).
**Create nasce no default OTIMOTEX** (`SK_COMPANY_DEFAULT`); edição mostra a empresa da conta.
No **lançamento em série** a empresa **PERMANECE** (o `resetSupplier` não a toca — igual aos
selects de classificação). Falha no lookup **não trava** o lançamento (fallback OTIMOTEX).
`sk_company` **é independente do fornecedor** — pode haver conta da LEBIANCO cujo fornecedor é a
OTIMOTEX. Ordem dos campos do form: **Fornecedor → Empresa → Descrição → Plano de contas → Centro de custo →
(Tipo de documento + Tipo de pagamento) → (Nº documento + Emissão) → (Valor + Vencimento) →
Código de barras → Informações adicionais** (os 3 pares na mesma linha; código de barras isolado;
**Informações adicionais** por último — `<textarea>` de texto livre, coluna
`financial_account_control.additional_info` TEXT nullable, migration 064). Esse texto é escrito
pelo usuário e **aparece no card de detalhe de `/consulta`** (bloco "Informações adicionais",
`whitespace-pre-wrap`) **E como um rodapé SEMPRE-visível abaixo das células do registro** no grid
(prop `renderRowFooter` do `DataGrid` — ver "Grid compartilhado"), destacado em fonte
`font-jakarta` itálica + texto `text-slate-600` sobre fundo `bg-status-warning-bg` (amarelo pastel);
só os registros com `additional_info` ganham o rodapé. É distinto de `processing_notes`
(auditoria/pipeline, exibido como "Observações") e nunca é tocado pela extração. Na
**inclusão** (modo `create`), **Emissão e Vencimento já vêm com a data de hoje** (`todayISO()`,
data local — `toFormValues` só preenche quando não há `defaultValues`; edição mantém os valores
da conta). **Lançamento EM SÉRIE (só `/contas`, modo `create`):** após **Lançar conta**, a página
**NÃO remonta** o form — mantém todos os campos, **limpa apenas o Fornecedor e o refoca** (handle
`ContaFormHandle.resetSupplier`, chamado por `ContasNovaPage` no sucesso e na falha parcial de
anexo). O `SupplierSelect` é remontado por `key` (o react-select não espelha `value`) com
`autoFocus`; os selects de **classificação (centro/plano) PERMANECEM** — só são re-semeados quando o
usuário escolhe um novo fornecedor (não regredir — ver [[conta-form-classification-selects]]). A
fila de anexos é descartada (já subiu). O modal de edição de `/consulta` **não** usa esse handle
(fluxo próprio). O **`ContaForm`** (inclusão/edição) **não** tem botão de exclusão; o **hard delete**
existe só no **painel de detalhe de `/consulta`** e só para o **grupo Administrador** (ver "CRUD de
contas" / "Hard delete dos cadastros"). Cliente Next API em `services/contas.ts` (proxy `/data-api`;
`deleteConta` faz o `DELETE`). Spec/template em `docs/prompts/api-contas-crud-spec.md`.

**Anexos de conta (N por conta — `financial_account_attachment`, migration 079):** o usuário anexa
**vários** arquivos (PDF/imagem) ao **incluir e ao editar** uma conta, no **mesmo bucket
`attachments`** do pipeline. A tabela é o **PADRÃO ÚNICO** das duas origens — `origin='pipeline'`
(documento que veio do e-mail, espelha `source_file` via backfill + registro no reader) e
`origin='manual'` (upload do usuário) —, então o painel lista todos igual. Antes, conta lançada à mão
era **permanentemente sem anexo**: `source_file` é uma coluna só e é bloqueada no CRUD manual (S3-2).

- **Upload em 2 passos, bytes FORA da Next API** (`lib/conta-attachments.ts`): `POST
  /api/contas/:id/attachments/upload-url` valida e devolve `{storage_key, signed_url, token}` →
  o **browser** envia direto ao Storage (`uploadToSignedUrl`) → `POST /api/contas/:id/attachments`
  registra a linha. Motivo: a Vercel corta o corpo de uma function em ~4,5 MB (foto de celular passa
  disso) e assim **não** é preciso dar INSERT em `storage.objects` ao papel `authenticated` — quem
  escreve segue sendo só o `service_role`, via a URL que ele emite. **Limite: 10 MB/arquivo**
  (`ATTACHMENT_MAX_BYTES`); mimes = `ATTACHMENT_MIME_TYPES` (espelha `_UPLOAD_CONTENT_TYPES` do reader).
- **A chave é gerada no SERVIDOR** — `manual/{account_id}/{YYYYMMDDTHHMMSSZ}_{rand8}_{nome}.{ext}`
  (`buildStorageKey`). O prefixo `manual/` torna a colisão com o pipeline **impossível por
  construção**: o `safe_filename` do reader remove a barra (`[^\w\s-]`), então **nenhuma chave do
  pipeline contém `/`**. A extensão vem do **mime validado**, não do nome do cliente; o `rand8` evita
  colisão de mesmo nome/conta/segundo (o reader resolve isso pelo disco, que aqui não existe).
  `safeFileName` espelha o `safe_filename` do Python (saídas conferidas contra ele no teste).
  **Se o cliente escolhesse a chave**, pediria autorização para o objeto do pipeline e o
  sobrescreveria — daí a chave ser do servidor + `createSignedUploadUrl` sem `upsert`.
- **Guards do register (a segurança do fluxo — não regredir):** a URL assinada **não valida
  conteúdo**, então (1) `isOwnManualKey` exige o **FORMATO INTEIRO** da chave gerada pelo servidor
  (422); (2) o objeto tem de existir (`storage.info()` → 422, mata a linha-fantasma); (3) **grava o
  `size`/`mimetype` REAIS do `info()`**, não os declarados — fora do limite/allowlist → 422 **+
  `storage.remove()`** do objeto (ainda não vinculado a conta nenhuma, então limpá-lo não fere a
  preservação). `info()` devolve **camelCase** (`contentType`/`size`) — o storage-js camelizA no
  runtime (`recursiveToCamel`).
- **PATH TRAVERSAL — por que o guard valida o FORMATO e não só o prefixo (não afrouxar):** o
  Supabase Storage **NORMALIZA o `..`** (verificado contra o bucket real: `info()` resolve,
  `createSignedUrl` assina e o download devolve HTTP 200 com os bytes). Um guard
  `key.startsWith('manual/{id}/')` aceitaria `manual/7/../../ester_HYOSUNG.pdf` (→ objeto do
  PIPELINE, na raiz) e `manual/7/../8/x.pdf` (→ anexo de OUTRA conta): o usuário registraria na
  conta dele um objeto alheio **sem subir nada** e o veria pela UI — furando a visibilidade por
  dono (076) e criando uma linha `origin='manual'` (removível!) para um documento de auditoria.
  Por isso `isOwnManualKey` casa a regex do formato completo (`ts_rand8_nome.ext`, extensão na
  allowlist), montada a partir das MESMAS constantes de `buildStorageKey`. Travado em
  `lib/conta-attachments.test.ts` (7 chaves forjadas + a chave real).
- **Erro de escrita passa por `mapWriteError` (§3 M-2 — não regredir):** default **500**, não 422.
  `failFromError` ECOA a mensagem de qualquer status < 500, então um erro inesperado do Postgres
  em 422 vazaria nome de tabela/constraint (cenário real: `file_name` só com espaços furava o
  `min(1)` do Zod e batia no CHECK `btrim(...)` → `23514`). Curados: `23505`→409, `23503`→404.
  O schema também tem `.trim()` antes do `.min(1)`, para o nome vazio morrer na validação.
- **Remoção = SOFT DELETE** (`deleted_at`/`deleted_by`) — o **objeto FICA no bucket** (política de
  preservação + policy RESTRICTIVE da 073). Anexo `origin='pipeline'` é **irremovível** (trilha de
  auditoria → **403**); anexo manual: só o **autor** ou o **grupo Administrador** (`isInAdminGroup`
  de `lib/auth.ts` — variante booleana de `requireAdminGroup`, pois o autor também pode).
- **Filtro de `deleted_at` EXPLÍCITO no repository (o bug mais provável desta feature):** a policy
  esconde o removido do papel `authenticated`, mas a Next API usa **service_role, que ignora a RLS**.
  Sem `.is('attachments.deleted_at', null)`, o PATCH devolveria anexos removidos e eles
  **reapareceriam no grid** (que mescla a resposta in-place, sem refetch). O filtro é de **recurso
  embutido** do PostgREST (não `!inner`): tira o anexo de dentro da conta sem descartar contas —
  conta sem anexo vem com `attachments: []`. Vale no retorno de INSERT/UPDATE (verificado contra o
  banco real). O `SELECT_WITH_EMBEDS` do frontend **não** filtra (lê como `authenticated`).
- **Modo CREATE: os arquivos sobem só DEPOIS do `POST /api/contas` devolver o id** — a fila fica em
  memória no `ContaForm` (prop `onSubmit(data, pendingFiles)`) e o **pai** faz o flush. A alternativa
  (staging + `move`) exigiria coletor de órfãos e uma exceção à preservação. **O modo EDIT usa o
  mesmo caminho** (subir ao escolher deixaria órfão se o modal fosse cancelado). Trade-off assumido:
  upload que falha deixa a conta sem aquele anexo → `Alert variant="warning"` **nomeando os
  arquivos** (dizer só "erro" faria o usuário relançar a conta e duplicá-la).
- **`onSubmit` DEVOLVE a fila que resta (não regredir — duplicava anexo):** o retorno de
  `onSubmit(data, files)` é `File[] | void` = os arquivos que **permanecem** na fila (`undefined`
  esvazia; **lançar** preserva tudo). Sem isso, na falha parcial — em que o modal de `/consulta`
  **fica aberto** e o form **não remonta** — um 2º submit reenviava a fila INTEIRA e **duplicava o
  que já subiu** (cada upload gera `storage_key` nova, então o UNIQUE não deduplica), e o próprio
  aviso "tente novamente" levava a isso. Hoje: `Consulta.handleEditSubmit` devolve só os que
  falharam **e** faz `setEditing(merged)` (senão a lista do modal não mostraria os recém-salvos);
  `ContasNovaPage` devolve `files` quando a CONTA falha (o erro é engolido lá, não sobe ao form).
- **Frontend:** `atoms/FileInputButton` (input file real + `sr-only` → teclado/leitor de tela de
  graça) · `molecules/AttachmentPicker` (fila controlada, valida mime/tamanho/duplicata no cliente —
  conveniência; quem manda é o backend) · `molecules/AttachmentList` (apresentacional pura, serve
  fila e salvos) · `organisms/ContaAttachments` (lista/viewer/remoção). **Assimetria deliberada:**
  adicionar é rascunho (efetiva no submit); **remover é imediato**, com confirmação. O
  `AttachmentViewer` ganhou a prop opcional **`title`** (nome amigável — sem ela o cabeçalho mostraria
  a chave crua `manual/512/2026…_Boleto.pdf`); segue recebendo a **chave crua** em `sourceFile`.
  Serviço em `services/contaAttachments.ts` (**não** usa o `call()` de `contas.ts`, que fixa
  `Content-Type: application/json`); `uploadContaAttachments` é **sequencial** (progresso honesto
  "2/3", falha isolada) e **NÃO lança** — devolve `{saved, failed}`.
- **Contenção do clique — nos BOTÕES, nunca num wrapper (não regredir):** no painel de detalhe de
  `/consulta` a lista e o viewer ficam **dentro do `<tr>`**, cujo `onClick` alterna a linha — sem
  conter, abrir/fechar/baixar um anexo **fecharia o próprio painel**. Quem chama `stopPropagation`
  são os botões/links do `AttachmentList`, da confirmação de remoção e do `AttachmentViewer`
  (Fechar/Baixar/Nova aba) — todos interativos, como já faziam os botões do detalhe. **Duas saídas
  que NÃO servem:** (a) `<div onClick={stopPropagation}>` em volta — handler em elemento
  não-interativo, reprovado pelo **SonarCloud** (S1082, quality gate); pôr um `onKeyDown` ao lado só
  para calar a regra seria código morto (o `<tr>` do DataGrid só tem `onClick`, e Enter/Espaço num
  `<button>` já gera um `click`, que é contido); (b) **`createPortal` para o body NÃO resolve** — o
  React propaga o evento pela árvore de **COMPONENTES**, não pela do DOM, então o clique alcança o
  `<tr>` mesmo com o `<dialog>` fora dele (verificado em teste; o `showModal` põe o dialog no top
  layer só VISUALMENTE). Os testes travam o COMPORTAMENTO ("o clique não alcança o ancestral"), não
  o mecanismo.
- **Fallback `legacySourceFile` (não regredir):** o registro no reader é **não-fatal**, então uma
  conta pode ter `source_file` e nenhuma linha. Sem o fallback o anexo do e-mail sumiria da tela —
  regressão contra o antigo botão "Ver anexo", que o painel de detalhe de `/consulta` substituiu pela
  lista (`ContaAttachments` com `canRemove={false}` — a remoção é pelo modal de edição). A condição é
  **"não há anexo de ORIGEM PIPELINE"**, não "não há anexo nenhum": com `rows.length === 0` o boleto
  do e-mail sumia assim que o usuário anexasse **um** arquivo manual — a mesma regressão, reintroduzida
  pela porta dos fundos. O item legado entra ANTES dos demais na lista.
- **Pipeline (`read_emails.py`):** `register_financial` passou a devolver **`int | None`** (o id da
  conta) em vez de bool — via `Prefer: return=representation` + `select=id`; os call sites
  `if ctrl.register_financial(...)` seguem válidos (id é truthy, None falsy). O vínculo é feito no
  **Passo 2**, após a conta existir (`register_attachment`, idempotente por
  `on_conflict=account_id,storage_key` + `ignore-duplicates`, **não-fatal**) — no Passo 1 não há id, e
  a conta pode nem ser criada. Registra **sempre que a conta é criada**, mesmo se o upload falhou (a
  tabela espelha o `source_file`); `storage_key == file_name` (nome flat). O anexo herda o **dono** da
  conta via `ctrl.resolve_user(sender_email)` — **NÃO** use `payload.get("created_by")`:
  `register_financial` resolve o dono numa **cópia local** do payload, então o dict do call site nunca
  o recebe e todo anexo cairia no sentinela, divergindo do backfill (que gravou o dono real).
  `resolve_user` é **cacheado por e-mail** na instância (a mesma caixa repete o remetente; a falha
  NÃO é cacheada). **Deploy: copiar só `read_emails.py`** (o `extract_pdf.py` não muda; sem `.env`; a
  079 já rodou na base compartilhada).

**CRUD de centros de custo (`apps/api-backend/lib/cost-centers.ts` + `app/api/cost-centers/**`):** CRUD
do cadastro `financial_cost_center` (grupo **Tabelas** da sidebar, página **`/tabelas/centros-de-custo`**
→ `pages/CostCentersPage.tsx`). PK `cost_center_id` é **SMALLINT IDENTITY ALWAYS** (gerada pelo banco,
nunca no corpo); o **id 0 é o sentinela "não informado"** — preservado, nunca listado/editado/excluído.
`GET /api/cost-centers` é **dois consumos do mesmo recurso, discriminados por `page`**: **sem `page`** =
lookup do cadastro (lista completa p/ o `<select>` de centro do form de Plano de contas — `lib/lookups.ts`
`costCenterService`, INTOCADO; NÃO é mais a cascata de classificação, que agora parte do plano);
**com `page`** = listagem paginada + busca por código/descrição do CRUD (`lib/cost-centers.ts`, exclui o
sentinela). `POST /api/cost-centers` cria · `GET/PATCH/DELETE /api/cost-centers/:id`. Validação Zod em
`@sheild/shared` (`costCenterCreateSchema` exige **código + descrição**; `costCenterUpdateSchema` parcial,
ao menos um campo). **Código único** validado na aplicação (case-insensitive — não há UNIQUE no banco) →
**409**. **`DELETE` é HARD DELETE** (a tabela não tem `deleted_at`), **bloqueado com 409** quando o centro
está referenciado por `financial_account_control`, `financial_chart_of_account` ou `supplier` (as 3 FKs);
o sentinela id 0 também é bloqueado. Status: `201` criação · `409` (código duplicado / em uso) · `404` ·
`422` Zod · `400` id inválido. A rota/lib `DELETE` é exposta na UI **apenas ao grupo Administrador**
(gate por `user_profile.group_id = 1` — ver "Hard delete dos cadastros"). Frontend:
`services/costCenters.ts` (proxy `/data-api`), `organisms/CostCenterForm.tsx` (código +
descrição), grid via `getCostCenterColumns` (ação **editar** por linha + **excluir** só para o grupo
Administrador). O botão de exclusão usa estilo inline (`bg-status-error-fg`) —
não há utilitário `btn-danger`.

**Grid COMPLEMENTAR — plano de contas do centro selecionado (mestre-detalhe):** `/tabelas/centros-de-custo`
é a única página de cadastro que é **mestre-detalhe**. **Clicar numa linha do centro SELECIONA** o centro
(alterna: clicar de novo/noutro desmarca) e carrega, **abaixo** da grade mestre, um **segundo `DataGrid`**
(`gridId="tabela-centros-de-custo-plano"`, isolado) com o **plano de contas LANÇÁVEL** (`is_postable=true`)
vinculado àquele centro — colunas **Código · Descrição · Grupo · Sub Grupo** (read-only, sem ações;
factory `getCostCenterChartAccountColumns` em `useGridColumns`). Ao selecionar um centro, o card do plano
**rola para a viewport** (`detailRef.scrollIntoView`, `scroll-mt-4`) — não abre no rodapé da página. A
**edição do centro continua abrindo SÓ pelo lápis** (a seleção pela linha não abre o modal — não conflita
com a regra "editar só pelo lápis").
Sem seleção, o grid mostra "Selecione um centro de custo para ver o plano de contas" e **não** consulta a
API; com centro sem planos lançáveis, "Nenhum plano de contas vinculado a este centro". **Abre ordenado
por Código ascendente** por padrão (estado inicial `detailSort = { col: 'account_code', dir: 'asc' }`;
envia `sort=account_code&order=asc`). Ordenação server-side (Código/Descrição + Grupo/Sub Grupo pela
descrição do embed via `alias(coluna)`) e paginação própria (evita truncar acima de `MAX_LIMIT=100`). **Backend (aditivo, retrocompatível):** o CRUD paginado
de plano de contas (`lib/chart-accounts.ts` + `app/api/chart-accounts` ramo COM `page`) ganhou os filtros
`cost_center_id` (inteiro > 0) e `postable=true`. Cliente:
`listChartAccountsByCostCenter(costCenterId, params)` em `services/chartAccounts.ts` (reusa o CRUD
paginado, envelope com `meta` + embeds). O ramo **SEM `page`** dessa rota **não** é mais a antiga cascata
por centro (removida) — passou a servir a cascata INVERTIDA: `description=`→centros do plano · senão→
descrições de planos (ver "Lookups de classificação contábil").

**CRUDs dos demais cadastros contábeis (grupo Tabelas) — Bancos, Contas, Plano de contas, Grupos,
Sub grupos:** mesmo padrão do CRUD de centros de custo (Repository → Service `service_role` → Route
dual-mode; código único na aplicação; **sem migrations**). **O HARD DELETE é exposto na UI apenas ao
grupo Administrador** — ver "Hard delete dos cadastros (grupo Administrador)". Um componente genérico
**`organisms/CrudTablePage.tsx`** (`<T, TInput>`: lista
paginada + busca debounce + modais criar/editar + confirmação de exclusão) é a base das 5 páginas
finas; o form de cada um vai por **render prop**. A busca usa a molécula **`SearchInput`** (lupa +
botão limpar/X que aparece só com texto e devolve o foco ao input) — compartilhada com
`CostCentersPage` e `SuppliersPage`. A célula "Ações" do grid renderiza o lápis (editar) e, **para o
grupo Administrador**, a lixeira (excluir) — `editCell`/`actionsCell` em `useGridColumns`.
Lookups nos forms via **`atoms/LabeledSelect.tsx`** (`<select>` rotulado, associação `htmlFor`/`id`).
Cliente HTTP compartilhado em **`services/dataApi.ts`** (`dataApiCall`/`dataApiListPaged`/`dataApiDelete`)
— também usado pelo **chat de IA** (`services/aiChat.ts`: `askAiChat`/`buildHistory`, ver "Chat de IA").

**Hard delete dos cadastros (grupo Administrador):** o botão de exclusão dos **6 cadastros do grupo
Tabelas** aparece **apenas para usuários do grupo Administrador** (`user_profile.group_id = 1`,
migration 065) e a exclusão é **HARD DELETE** (físico, bloqueado com **409** por FK quando o registro
está em uso; o sentinela id 0 também é bloqueado). **Duas camadas:** (1) **gate de UI** — `AuthContext`
carrega `groupId`/`isAdminGroup` lendo `user_profile` do próprio usuário (RLS da 065 permite só o
próprio perfil); `CrudTablePage` e `CostCentersPage` só oferecem a lixeira + o modal de confirmação
quando `isAdminGroup`; (2) **trava real (backend)** — as 6 rotas `DELETE` (`app/api/{banks,
financial-accounts,chart-accounts,chart-account-groups,chart-account-subgroups,cost-centers}/[id]`)
usam **`requireAdminGroup`** (`lib/auth.ts`), que resolve o `group_id` do usuário via `service_role` e
devolve **403** fora do grupo. O gate de UI é só cosmético — a autorização é imposta no servidor.
**Distinto de `requireAdmin`** (papel `app_metadata.role='admin'`), que segue restrito a
`POST /api/users` (criar usuário): os dois convivem — papel `role` para gestão de usuários, **grupo**
para o hard delete. Constante `ADMIN_GROUP_ID = 1` espelhada no backend (`lib/auth.ts`) e no frontend
(`AuthContext.tsx`). **Escopo:** os 6 cadastros de Tabelas **e** o hard delete de conta em `/consulta`
(`DELETE /api/contas/:id` — ver "CRUD de contas"); `/fornecedores` segue **soft delete**. A remoção
PADRÃO de conta continua sendo `PATCH status_id=<cancelado>` — o hard delete é a exceção do grupo
Administrador (pedido do usuário).
Testes: `lib/auth.test.ts` (`requireAdminGroup`: 401/403/500 + grupo 1 segue), `AuthContext.test.tsx`
(gate por grupo), `CrudTablePage.test.tsx` (lixeira só p/ o grupo Administrador) + os 6 `route.test.ts`
(mock de `requireAdminGroup`).

**Grids dos cadastros = padrão do `/consulta` (gestão de colunas):** todos os grids de cadastro —
os **6 do grupo Tabelas** (`CrudTablePage` + a página autônoma `CostCentersPage`) **e** `/fornecedores`
(`SuppliersPage`) — ligam o mesmo conjunto do grid de `/consulta`: `enableColumnManagement` (toolbar:
mostrar/ocultar, **fixar**, **reordenar por arraste**, **redimensionar**, restaurar layout),
`defaultDensity="compact"`, `maxBodyHeight` (`70vh` → **cabeçalho fixo**) e `gridId` próprio
(preferências de layout persistidas em `localStorage` por tabela — ids `tabela-bancos`,
`tabela-contas`, `tabela-plano-de-contas`, `tabela-grupos-plano-de-contas`,
`tabela-subgrupos-plano-de-contas`, `tabela-centros-de-custo`, `tabela-centros-de-custo-plano`
(grid complementar do plano de contas — ver "Grid COMPLEMENTAR"), `fornecedores`). No `CrudTablePage` o
`gridId` é prop obrigatória, passada por cada página fina. **Não** ligam `enableSelection` (sem ação
em lote nesses cadastros) nem `enableRowVirtualization`/scroll infinito (a paginação é por botões
Anterior/Próxima) — decisão de escopo: o grid é o **mesmo componente** e a mesma experiência de
colunas/densidade, sem os recursos específicos do `/consulta` (volume + ações em massa).

**Ordenação SERVER-SIDE nos grids de cadastro (clique no cabeçalho):** o clique cicla
**asc→desc→nenhum** (`handleSort` idêntico ao do `/consulta`; reseta para a 1ª página) e a ordenação
é sempre **server-side** — `sort`/`order` viajam na query (`?sort=<col>&order=asc|desc`) até a Next
API. **Por que server-side:** os cadastros são paginados (20/página), então ordenar só a página
carregada seria incorreto. Wiring: `CrudTablePage` (5 cadastros) + `CostCentersPage`/`SuppliersPage`
(autônomas) mantêm o estado `{col,dir}` e o repassam à função `list`; o cliente HTTP
(`services/dataApi.ts` `dataApiListPaged` + as cópias de `costCenters.ts`/`suppliers.ts`) anexa
`sort`/`order` à query. No backend, cada `service.list`/`findAll` recebe `sort`/`order` e aplica
`.order(col)` **validando a coluna contra um allowlist por recurso** (`SORTABLE_COLUMNS`) via o helper
**`lib/sort.ts`** (`resolveSort` + `parseSortParams`); coluna fora do allowlist → ordem **default** do
recurso (defesa contra coluna inválida/injeção). As rotas só **encaminham** `...parseSortParams(sp)`
(verbatim) — o allowlist é responsabilidade do service. **Colunas de embed/JOIN são ordenáveis pela
descrição via a sintaxe do PostgREST `alias(coluna)`** (o `sortKey` usa o MESMO alias do `select`),
ordenando as linhas-pai pela coluna do recurso embutido (to-one) — assim a ordem casa o texto exibido.
Padrão herdado do `/consulta` (`sortKey:'supplier(trade_name)'`, `'cost_center(cost_center_description)'`,
`'chart_account(account_description)'`). Em `/tabelas/plano-de-contas` as 3 colunas de classificação
usam o mesmo: Centro de custo→`'cost_center(cost_center_description)'`, Grupo→`'group(group_description)'`,
Sub Grupo→`'subgroup(subgroup_description)'`. O valor do `sortKey` (literal, incluindo a forma
`alias(coluna)`) entra no `SORTABLE_COLUMNS` do service (allowlist — defesa contra coluna arbitrária);
quando o `select` NÃO inclui o alias, a coluna fica sem `sortKey` (ex.: `bank` em `/tabelas/contas`). Em
`suppliers`, o `sort` aceita também o alias legado **`name`** (lookup do modal de contas → `trade_name`
asc); colunas reais do grid usam `sort=<coluna>&order=`. Testes: `lib/sort.test.ts` (helper) e
`app/api/suppliers/route.test.ts` (encaminhamento).

| Cadastro | Sidebar / rota | Backend (`lib` + `app/api`) | Particularidades |
|---|---|---|---|
| `financial_bank` | **Bancos** `/tabelas/bancos` | `banks.ts` + `banks/**` | PK `bank_id` **NÃO identity** → `create` grava `max+1`. `bank_code` CHAR(3). Delete bloqueado se referenciado por `financial_account` |
| `financial_account` | **Contas bancárias** `/tabelas/contas` | `financial-accounts.ts` + `financial-accounts/**` | Contas bancárias/caixa (distinto de `/contas`=lançamentos). **Sem sentinela, sem FK reversa** → delete livre. `status_id`→**FK `status`** (migration 053; lookup `GET /api/statuses`; default 30="ativo"); `payment_type_id` **input numérico** (sem tabela de domínio); banco via lookup; saldo `NUMERIC` |
| `financial_chart_of_account` | **Plano de contas** `/tabelas/plano-de-contas` | `chart-accounts.ts` + estende `chart-accounts/**` | **GET dual-mode preserva a CASCATA** (sem `page` = lookup por centro, só postáveis — `lib/lookups`; com `page` = CRUD — `lib/chart-accounts`). FKs opcionais centro/**grupo** (`chart_account_group_id` — FK direta, migration 058)/subgrupo (0="não informado"); `account_level`/`is_postable`. **Grid** (ordem): Código · Descrição · Centro de custo · Grupo · Sub Grupo (Nível e Lançável saíram do grid — seguem no form). **Todas as 5 colunas são ordenáveis** (server-side; as 3 de classificação pela descrição do embed via `alias(coluna)`). Delete bloqueado por `financial_account_control`/`supplier` |
| `financial_chart_of_account_group` | **Grupos** `/tabelas/grupos-plano-de-contas` | `chart-account-groups.ts` + `chart-account-groups/**` | `group_type` CHAR(1) opcional (legado). **`type_group_id`→FK `financial_type_group`** = **NATUREZA** (lookup escopado `?scope=group`; ver "Escopo do `financial_type_group`"). Delete bloqueado se referenciado por subgrupo |
| `financial_chart_of_account_subgroup` | **Sub grupos** `/tabelas/subgrupos-plano-de-contas` | `chart-account-subgroups.ts` + `chart-account-subgroups/**` | FK `chart_account_group_id` **obrigatória** (NOT NULL; 23503→422). **`type_group_id`→FK `financial_type_group`** = **TIPO** (Despesa Fixa/Variável — coluna "Tipo" no grid/form; lookup escopado `?scope=subgroup`; ver "Escopo do `financial_type_group`"). Delete bloqueado se referenciado por plano de contas |

**Hierarquia:** grupo → subgrupo (`chart_account_group_id`) → plano de contas (`chart_account_subgroup_id`
+ `cost_center_id`). O plano de contas tem **também uma FK DIRETA ao grupo** (`chart_account_group_id`,
migration 058 — coexiste com a ligação indireta via subgrupo; embed `group` na grade/form, editável no
CRUD); banco → conta (`bank_id`). **Rotas dual-mode** (Bancos/Grupos/Sub grupos): com `page`
= CRUD paginado; sem `page` = lookup (lista completa p/ os `<select>`). **`MAX_LIMIT = 1000`** nesses
três services (igual a `lib/lookups.ts`) para o lookup não truncar o `<select>`; a paginação do CRUD
usa `DEFAULT_LIMIT`. **`GET /api/statuses`** (read-only,
`statusService` em `lib/lookups.ts`) alimenta o lookup de situação do form de Contas. Lookups no frontend:
`services/lookups.ts` (`listBanks`/`listChartAccountGroups`/`listChartAccountSubgroups`/`listStatuses` +
`listCostCenters` + `listPlanoDescriptions`/`listCentersForPlano` da cascata invertida). Schemas Zod
em `@sheild/shared` (`bank`/`financial-account`/
`chart-account`/`chart-account-group`/`chart-account-subgroup`). **Selects obrigatórios vazios** chegam
como `NaN` (`valueAsNumber`) e são **normalizados para 0** nos forms antes do `safeParse` (0 dispara o
`.min(1)` com a mensagem amigável). **Pendência conhecida:** `payment_type_id` é input numérico cru
(não há tabela de domínio no banco) — melhoria futura.

**Escopo do `financial_type_group` — `applies_to` (migration 094 — não regredir):** o catálogo
`financial_type_group` hospeda **DUAS taxonomias distintas** referenciadas por `type_group_id`: a
**NATUREZA** do grupo (`financial_chart_of_account_group` — Receitas/Despesas/Ativo/Passivo, ids 1-4,
rótulo "Natureza") e o **TIPO** do subgrupo (`financial_chart_of_account_subgroup` — **Despesa Fixa/
Variável**, ids 5-6, rótulo "Tipo"; a classificação Fixa/Variável dos 155 subgrupos foi feita pelas
migrations **092/093**, por subgrupo, não herdando o grupo em bloco). As duas colunas são
`SMALLINT NOT NULL DEFAULT 0` (0 = "Não informado") com FK ao mesmo catálogo. Como os dois selects
liam o **mesmo** lookup, cada um oferecia as opções do outro (subgrupo com Natureza="Ativo", grupo com
Tipo="Despesas Fixas") — sem sentido e sem guarda. A **coluna `applies_to`** (`'group'`/`'subgroup'`/
`'both'`; CHECK; DEFAULT `'both'`) escopa cada linha (0→both, 1-4→group, 5-6→subgroup):
- **Lookup escopado** (`financialTypeGroupService.list({scope})` → `applies_to IN ('both', scope)`;
  rota `GET /api/financial-type-groups?scope=group|subgroup`; cliente `listFinancialTypeGroups(scope)`).
  A página de Grupos pede `'group'`, a de Sub grupos `'subgroup'`; ambas recebem o id 0. **Sem `scope`
  a rota retorna TODAS** (retrocompat) — mas todo consumidor hoje passa escopo.
- **Validação autoritativa em aplicação** (`validateTypeGroupScope` em `lib/lookups.ts`, chamada em
  `create`/`update` dos dois services): impede atribuir Natureza de subgrupo a um grupo e vice-versa
  (→ **422**), pois a FK só garante EXISTÊNCIA, não validade semântica. Mesmo espírito de
  `lib/classification.ts` (a única via de escrita destes cadastros é a Next API/service_role; não há
  pipeline gravando aqui). id 0 pula a consulta; id inexistente → 422 amigável. Na EDIÇÃO, o form
  reenvia o `type_group_id` atual — os dados são 100% consistentes com o escopo (0 linhas fora), então
  editar registro histórico não dispara falso 422. Testes: `lib/lookups.test.ts` (escopo + validação),
  `chart-account-{groups,subgroups}.test.ts` (create/update com escopo), a11y dos dois forms.

**Lookups de classificação contábil — CASCATA INVERTIDA Plano → Centro (2026-07-18):** a pedido do
usuário, o `ContaForm` e o `SupplierForm` escolhem o **Plano de contas PRIMEIRO** (por descrição) e o
**Centro de custo DEPOIS** (os centros que compõem aquele plano). Antes era Centro → Plano. **Modelo de
dados inalterado** (`financial_chart_of_account.cost_center_id` = plano→1 centro; a conta grava
`chart_account_id` + `cost_center_id`) — a inversão é só na UX, **sem migração**. A mesma **descrição**
de plano ("Serviços Gerais") existe em vários centros como linhas/códigos DISTINTOS (~530 descrições em
~547 planos postáveis). Cadastros `financial_cost_center`/
`financial_chart_of_account` (pré-existentes, também geridos pelos CRUDs de Tabelas). Backend:
`apps/api-backend/lib/lookups.ts` (`chartAccountService.listPlanoDescriptions`/`listCentersForPlano` +
`costCenterService`, service_role) + rota `GET /api/chart-accounts` (dispatch: `page`→CRUD ·
`description=`→centros do plano · senão→descrições de planos). Cliente: `services/lookups.ts`
(`listPlanoDescriptions`/`listCentersForPlano`; o antigo `listChartAccounts` por centro foi **REMOVIDO**).

- **1º select — `ChartAccountSelect` (Plano):** `value` = a **DESCRIÇÃO** (string), não id. Lista as
  descrições DISTINTAS de planos postáveis com centro válido (`listPlanoDescriptions`, `is_postable=true`
  + `cost_center_id > 0`). **A dedup é em JS**, então o LIMIT usa `MAX_LIMIT` (não `DEFAULT_LIMIT`) para
  NÃO truncar antes de deduplicar — com 547 linhas e limite 500 sumiam ~47 descrições do fim do alfabeto
  (bug corrigido na revisão; se o cadastro passar de `MAX_LIMIT` linhas postáveis, migrar p/ DISTINCT via
  RPC). Busca por código/descrição.
- **2º select — `CostCenterSelect` (Centro):** prop `planoDescription` (cascata; **sem plano →
  desabilitado e `[]` sem ir ao banco**). Lista as linhas postáveis com aquela descrição
  (`listCentersForPlano`, `.eq(account_description)` + `cost_center_id > 0`); cada opção resolve um
  `chart_account_id` específico + o seu `cost_center_id`, e o `onChange(chartAccountId, costCenterId)`
  devolve **os dois juntos** (sempre consistentes). Rótulo pela descrição do centro; nos 3 casos raros de
  mesma descrição repetida no MESMO centro (2 códigos), anexa o `account_code` p/ diferenciar.
- No `ContaForm`/`SupplierForm`, trocar o PLANO **zera o centro** (`handlePlanoChange`) — o
  `CostCenterSelect` recarrega via `key={planoDescription}` no `<AsyncSelect>` interno. Os dois selects
  são **CONTROLADOS** (espelham `value` no render; **não** remonte por `key`/`prefillNonce` do componente
  — ver [[conta-form-classification-selects]], já regrediu 3x). Exibem só a descrição (fallback → `#id`).

**Validação do par (autoritativa — `apps/api-backend/lib/classification.ts` `checkClassificationPair`):**
não gravar plano sem centro relacionado (e vice-versa), nem ids inexistentes, nem par inconsistente. Regra:
ambos 0 ("não informado") → ok; só um informado → 422 "Informe … juntos"; ambos > 0 → o plano existe, o
centro existe e o `cost_center_id` da linha do plano **bate** o centro informado (senão 422 "não pertence
ao plano"). **NÃO valida `is_postable`** (o select já só oferece postáveis; re-impor bloquearia editar
conta histórica cujo plano foi desativado — plano não-lançável ainda é FK válida). Erro de INFRA do banco
→ `throw` (500 genérico, sem vazar detalhe), não 422. Chamado em `contaService.create/update` e
`supplierService.create/update`; espelhado no front (`classificationError` "Selecione o centro de custo do
plano informado"). O **pipeline Python bypassa** (service_role) e já produz par consistente por construção.
**Sem migração** — dados atuais 100% consistentes (0 pares inconsistentes/parciais). Testes:
`lib/classification.test.ts`, `lib/lookups.test.ts`, `lib/contas.test.ts`/`suppliers.test.ts` (mock),
`ContaForm.test.tsx`/`SupplierForm.test.tsx`, `Cost/ChartAccountSelect.test.tsx`.

**Classificação default do fornecedor — sync bidirecional (migration 052):** `supplier` tem
`cost_center_id`/`chart_account_id` (SMALLINT NOT NULL DEFAULT 0, sentinela 0 = "não informado"),
e a classificação flui nos **dois sentidos**:
- **Default na criação (supplier → conta).** Ao incluir conta, a nova `financial_account_control`
  herda a classificação do fornecedor quando `> 0`. (a) **Ao ESCOLHER/TROCAR o fornecedor**
  (`handleSupplierChange`, ambos os modos) `getSupplier(sk)` (`services/suppliers.ts` →
  `GET /api/suppliers/:sk`, com `cost_center_id`/`chart_account_id` + embeds) semeia os estados
  `chartAccountDescription` (do embed `chart_account.account_description`), `chartAccountId` e
  `costCenterId` — os selects são CONTROLADOS e refletem sozinhos (sem `prefillNonce`/remonte por `key`).
  No mount da EDIÇÃO **não** busca o fornecedor (usa a classificação da própria conta). (b) **Extração de e-mail**:
  `SupabaseControl.supplier_defaults(sk)` (`read_emails.py`) lê os defaults e `_finalize_supplier`
  os injeta no payload quando `> 0` (cobre PDF e corpo; `0`/ausente → o `DEFAULT 0` do banco assume,
  nunca enviamos `None`).
- **Write-back na gravação pelo modal (conta → supplier).** `contaService.create`/`update`
  (`lib/contas.ts`), **após** o write, gravam a classificação de volta no fornecedor via
  `setSupplierClassification(sk, cc, ca)` (`lib/suppliers.ts`, caminho dedicado fora do
  `supplierUpdateSchema`) **apenas quando `cost_center_id > 0` E `chart_account_id > 0`** — vale na
  **criação E na edição** pelo modal. **Best-effort**: falha no write-back loga (`console.error`) e
  **não** derruba a resposta da conta. A **extração Python não passa por esse service** → não faz
  write-back (só lê). Schema: `supplierSchema` (leitura) expõe `cost_center_id`/`chart_account_id`
  + embeds opcionais `cost_center`/`chart_account`; `findBySk` faz o JOIN.
- **Edição direta pelo CRUD de fornecedores (`/fornecedores`).** `cost_center_id`/`chart_account_id`
  **agora entram em `editableFields`** (POST/PATCH públicos de fornecedor) — o form de fornecedor
  (`SupplierForm`) traz os lookups **Plano de contas** e **Centro de custo** em CASCATA INVERTIDA (mesmos
  `ChartAccountSelect`/`CostCenterSelect` do `ContaForm`; trocar o plano zera/recarrega o centro). O
  payload **sempre** envia os dois ids (`0` quando não informado), cobrindo definir **e LIMPAR** no
  modo edição (omitir não zeraria a coluna num PATCH parcial). Na edição, `SuppliersPage.openEdit`
  busca o fornecedor completo (`getSupplier` → `GET /suppliers/:sk`, com embeds) para rotular os
  selects; a lista (`GET /suppliers`) traz só os ids. O write-back do modal de contas
  (`setSupplierClassification`) **permanece** como caminho paralelo (grava só quando ambos `> 0`).
- **EXCEÇÃO — fornecedor de FUNCIONÁRIO NÃO carrega classificação default (migration 070 — não
  regredir):** quando o `trade_name` do fornecedor contém "funcionário"/"Funcionário" (sem acento/
  caixa, via `normalize_search LIKE '%funcionario%'`), `supplier.cost_center_id`/`chart_account_id`
  são **mantidos em 0** — a classificação de despesa de funcionário (reembolso/adiantamento) varia
  por conta, então um default no cadastro não faz sentido. Enforcement por **trigger**
  `trg_supplier_no_funcionario_classification` (BEFORE INSERT/UPDATE em `supplier`, força cc/plano=0)
  — fonte ÚNICA que cobre TODOS os caminhos de escrita: write-back do modal (`setSupplierClassification`),
  write-back da extração (`update_supplier_classification`), edição pelo CRUD (`/fornecedores`) e UPDATE
  direto (todos viram no-op para funcionário). A classificação por **conta**
  (`financial_account_control`) NÃO é afetada — só o default do fornecedor. Backfill único zerou os
  fornecedores de funcionário já classificados (ex.: "Josefa/Edvaldo/Tania (Funcionário)").

**Contato do fornecedor — telefone / WhatsApp / chave PIX (migration 082):** `supplier` tem
`phone_ddd1`/`phone1`/`phone_ddd2`/`phone2` (char(2)/varchar(9)), `whatsapp1`/`whatsapp2`
(varchar(11)) e `pix_key1`/`pix_key2` (varchar(77)) — **2 "slots" por tipo**, todos nullable,
escrita só por `service_role`. Dois caminhos de preenchimento:
- **Edição de fornecedores (`/fornecedores`, `SupplierForm`):** campos de texto simples;
  telefone/WhatsApp gravam só dígitos (strip de máscara no Zod, como cnpj/cpf), `pix_key` aceita
  e-mail/UUID. Entram em `editableFields` de `@sheild/shared` → fluem para create/update sem
  mudança no repositório (o `SELECT '*'` já os devolve).
- **Extração de e-mail (`read_emails.py`):** `parse_supplier_contacts(text, exclude_pix)` detecta
  do CORPO/assunto/descrição (decisão: NÃO toca no prompt do PDF) — chave PIX **só com rótulo
  "pix" por perto** (janela de 80 chars, `finditer` que pula candidato excluído; anti-falso-
  positivo), telefone por formato `(DD) NNNNN-NNNN`/rótulo (**DDD default 11** quando ausente) e
  WhatsApp por rótulo (**precede** o slot de telefone via `exclude_digits`). `apply_contact_writeback`
  roda após `apply_forced_classification` nos dois choke points (PDF `:3562`, corpo `:3723`),
  **não** toca no payload da conta, e chama `SupabaseControl.update_supplier_contact` — **lógica de
  2 slots** (espelha o trigger `_add_supplier_email`: preenche o slot 1; o 2 só quando o 1 tem
  OUTRO valor; no-op se já presente ou ambos cheios). Best-effort (falha loga, não derruba a
  conta); **pula OTIMOTEX (sk=1)**. O **CNPJ do pagador** (`payer_cnpj` + `company_cnpj()`) é
  **excluído** das chaves PIX — o bloco do pagador vem no corpo reencaminhado e pode ficar perto de
  "pix". WhatsApp É auto-detectado (além de editável no form). Testes:
  `tests/test_supplier_contacts.py` (parser + slots + guards).
- **Backfill retroativo:** `scripts/backfill_supplier_contacts.py` (`--dry-run`) varre todas as
  contas, agrupa por `sk_supplier` e grava com a mesma lógica de slot (idempotente; exclui o
  `company_cnpj()`). **Aplicado em 2026-07-16** (31 fornecedores; re-run reporta 0 mudanças).
- **Deploy:** copiar só `read_emails.py` (o `extract_pdf.py` NÃO muda — detecção é só do corpo); a
  migration 082 já vale para dev+prod (mesma Supabase). Validar: `py -3 -c "import sys;
  sys.path.insert(0,'skills/email-reader/scripts'); import read_emails as R;
  print(hasattr(R,'parse_supplier_contacts'), hasattr(R.SupabaseControl,'update_supplier_contact'))"`.

**Usuários / autenticação (`apps/api-backend/lib/users.ts` + `app/api/users|auth/**`):** sobre
o **Supabase Auth** — sem tabela própria, sem JWT customizado, sem bcrypt (regras de
`auth-specs.md`). `POST /api/users` cria usuário (**admin-only**, via `auth.admin.createUser`
com `email_confirm: true`; **SEM AUTO-REGISTRO** — exige `requireAdmin` (`lib/auth.ts`:
papel lido de `app_metadata.role === 'admin'`, campo controlado pelo servidor/Admin API;
**não basta estar logado** → `403` se não-admin; correção da auditoria de segurança §1 A-1)
além do middleware) → `201`
`{ id, name, email }`; `POST /api/auth/login` é **público** (exceção no matcher:
`/api/((?!health|auth/login).*)`) e devolve `{ access_token, expires_in }` via
`signInWithPassword`; `GET /api/users/me` usa `getAuthenticatedUser` (`lib/auth.ts`) → perfil.
Schema `createUserSchema` em `@sheild/shared` (reusa `loginSchema`). Nunca expõe `password_hash`.
Spec/template em `docs/prompts/api-users-auth-spec.md`.

**Auth das rotas Next (`apps/api-backend/middleware.ts` + `lib/auth.ts`):** o middleware
protege `/api/*` (matcher `/api/((?!health|auth/login).*)` — `/api/health` e `/api/auth/login`
ficam públicos) exigindo
`Authorization: Bearer <token>`. O token é validado contra o Supabase Auth (`auth.getUser`)
com a **chave anon** (`SUPABASE_ANON_KEY`, nunca a service_role); sem token/ inválido →
`401`, falha de validação → `500` (envelope `fail`). A lógica fica em `lib/auth.ts`
(`requireAuth`/`requireAdmin`/`requireAdminGroup`/`getBearerToken`, testável). `/api/emails/read` também chama
`requireAuth` no handler (defesa em profundidade, não só o middleware). Isso **não**
intercepta o caminho atual do frontend (leitura de e-mails fala com o Flask direto); cobre a
API de dados Next p/ a fase do portal.

**Modelo de papéis (decisão de design — ferramenta single-org):** **toda sessão autenticada
é confiável para operar o app** — qualquer usuário logado faz **criação/edição** (fornecedores,
contas, cadastros das Tabelas) e **consultas/dashboards**. As rotas de criação/edição usam só
`requireAuth` (sessão válida), **não** papel. **Duas exceções restritas:** (1) `POST /api/users`
(criar usuário) exige `requireAdmin` — papel lido de `app_metadata.role === 'admin'` (campo
controlado pelo servidor/Admin API; ver §1 A-1 da auditoria de segurança); (2) o **hard delete dos
6 cadastros do grupo Tabelas** exige `requireAdminGroup` — pertencer ao **grupo Administrador**
(`user_profile.group_id = 1`, migration 065; ver "Hard delete dos cadastros"). Fora dessas duas, não
há segregação de papéis no CRUD — se um projeto precisar de mais, abrir tarefa dedicada (RBAC
completo desenhado em `docs/design/permissoes-por-grupo.md`).

> **Recorte importante — "confiável" NÃO é "vê e edita tudo" (não confundir).** O modelo acima é
> sobre **papel/função**: nenhum CRUD é reservado a um cargo. Já a **visibilidade por LINHA** é uma
> dimensão à parte e ATIVA: o grupo com `user_group.sees_only_own_accounts` (hoje só o **Comercial**)
> só **vê** — e portanto só **edita** — as contas em que é dono, os e-mails/erros de que é remetente
> e os anexos correspondentes. A regra é imposta no BANCO (RLS 076/078/079/**080** no Storage e
> **081** no UPDATE) e na Next API (`canSeeConta`), não na tela. Os demais grupos (Financeiro,
> Diretor, Administrador…) veem e editam livremente a conta de qualquer usuário, anexos inclusos —
> como o modelo single-org prevê. Ver "Visibilidade de contas por dono".
**Cadastro de operadores:** crie no **Supabase Dashboard** (Authentication → Users → Add user,
com "Auto Confirm User"); operador comum **não** precisa de papel/`app_metadata` — só o usuário
que for criar outros via API precisa de `app_metadata.role: "admin"`. RLS (migrations 056/057)
não afeta o app: o CRUD escreve via Next API com **`service_role`** (ignora RLS); só a curadoria
inline (`has_invoice`/`has_bank_slip`/`status_id` em `financial_account_control`, `reviewed_at` em
`email_control`) é escrita direto pelo papel `authenticated`, via grants por coluna preservados.

**Grupos de usuário — permissões por grupo (FUNDAÇÃO + VÍNCULO aplicados; RESTO do RBAC DESENHADO,
não implementado):** existe a base para, no futuro, segregar acesso/visualização por grupo (o "abrir
tarefa dedicada" citado acima). **Aplicado (migration 063):** catálogo `public.user_group`
(`group_id` IDENTITY ALWAYS PK, `group_name` VARCHAR(30) DEFAULT ''; **id 0 = sentinela "não
informado"**; RLS read `authenticated`/write `service_role`) + backfill `app_metadata.group_id=0`
nos usuários existentes. **`user_group` é editado EXCLUSIVAMENTE via Supabase** (SQL Editor/
Dashboard) — **sem CRUD no app** (o frontend só lê o catálogo); preservar em limpezas de dados.
**Aplicado (migration 065) — vínculo usuário→grupo por FK real:** `public.user_profile`
(`user_id` PK → `auth.users(id)` ON DELETE CASCADE; `group_id` SMALLINT NOT NULL DEFAULT 0 →
`user_group`; RLS SELECT restrita a `auth.uid() = user_id`, write `service_role`) + trigger
`handle_new_user` (AFTER INSERT ON `auth.users`, SECURITY DEFINER → cria perfil com group_id=0) +
backfill dos usuários atuais. **`user_profile` é a FONTE DE VERDADE** do vínculo (supersede o claim
`app_metadata.group_id` da 063, que **não** é sincronizado — reconciliar no enforcement futuro).
Atribuição é feita **via Supabase** (`UPDATE public.user_profile SET group_id=… WHERE user_id=…`;
sem tela de admin). Classificações atuais: `ricardo@sheild.com.br`=1 (Administrador),
`barbara@otimotex.com.br`=7 (Financeiro), demais=0. **Preservar `user_profile` em limpezas.** O nº
064 do repo já era `additional_info` → o user_profile virou **065** (roadmap renumerado 066–068).
**Resto do RBAC — desenhado, ainda NÃO implementado** (blueprint em
[docs/design/permissoes-por-grupo.md](docs/design/permissoes-por-grupo.md)): permissões via
`permission(resource,action)` + `group_permission` (cobre tela/menu **e** CRUD); visibilidade por
linha via `group_company`/`group_cost_center`/`group_chart_account` (empresa + centro de custo +
plano de contas). **Semântica RLS:** dimensão sem linhas = vê tudo (restrição opt-in), dimensões com
AND, bypass `service_role`/`app_metadata.role='admin'`. Enforcement por camada: `view`=menu
(frontend esconde + guarda rota) · CRUD=Next API `requirePermission` (escrita é `service_role`, RLS
não pega) · linha=RLS em `financial_account_control`. Roadmap restante: migrations 066–068 + helpers
`belongsToGroup`/`requirePermission` em `lib/auth.ts` + menu no `Layout.tsx`. Ler o blueprint antes
de implementar.

**Vínculo usuário → EMPRESA: NÃO EXISTE — implementado e REVERTIDO em 2026-07-17 (não reimplementar
sem pedido explícito):** chegou a existir uma migration `084_create_user_company.sql` (tabela N:N
`user_company` — `user_id` + `sk_company`, RLS, REVOKE, extensão do `handle_new_user` e backfill),
mais `getUserCompanies()` em `lib/auth.ts` e `skCompanies` no `AuthContext`. **Tudo foi desfeito a
pedido do usuário** ("não vou mais trabalhar com identificação de company nos usuários"): a tabela
foi dropada, o `handle_new_user` restaurado à versão da 065 e o código/doc revertidos — verificado
sem resíduo (0 objetos `user_company` no catálogo; nenhuma referência no repo). (O nº 084 foi
liberado e **já reutilizado** pela regra LEBIANCO — próxima = 085.) **Não "ajude" recriando isso.**
Se o tema voltar: o blueprint aprovado
(`docs/design/permissoes-por-grupo.md`) roteia empresa **pelo GRUPO** (`group_company`; decisão
travada 1 = "o único vínculo direto do usuário é o grupo") — a tentativa revertida divergia dele ao
vincular por usuário. Hoje o único vínculo do usuário é `user_profile.group_id`.

**Visibilidade de contas por DONO, por grupo (Etapa 1 APLICADA — migration 076):** primeira
dimensão de visibilidade por linha efetivamente em produção (independente do blueprint acima, que é
por empresa/centro/plano). Cada `financial_account_control` tem **`created_by`** (UUID → `auth.users`,
NOT NULL DEFAULT sentinela `financeiro@otimotex.com.br` `89ce3055-…` (era `teste@otimotex.com.br` até a migration 110), FK `ON DELETE SET DEFAULT`) = o DONO.
**Preenchimento (server-side, nunca do corpo do cliente):** UI nova conta → Next API carimba o
usuário logado (`getAuthenticatedUser(req).id`, `contaService.create(raw, userId)` em `lib/contas.ts`;
POST usa `getAuthenticatedUser`, não `requireAuth`); extração → `SupabaseControl.resolve_user(sender_email)`
(RPC `resolve_user_for_account`, sentinela quando não casa) injetado no `register_financial`; fallback
= DEFAULT da coluna. **Restrição por grupo (opt-in):** flag `user_group.sees_only_own_accounts` (só
**Comercial=6** ligada; **Financeiro=7** e demais = false → veem tudo). **Enforcement por RLS SELECT**
de `financial_account_control`: `USING (NOT public.auth_group_sees_only_own() OR created_by = auth.uid())`
— cobre `/consulta` (grid + busca) e `/dashboard_vencimentos`, que leem via `authenticated`; `service_role`
(Next API/Python) mantém bypass. **Estendido a `/emails` e `/erros` (migration 078):** as policies
SELECT de `email_control` e `email_processing_errors` usam a MESMA flag/helper, porém casando o
REMETENTE com o e-mail do logado — `USING (NOT public.auth_group_sees_only_own() OR
lower(sender_email) = lower(auth.email()))`. Diferença intencional de chave: `/consulta` casa por
`created_by` (UUID resolvido, com sentinela); `/emails` e `/erros` casam o TEXTO `sender_email`
diretamente com `auth.email()`. Linhas com `sender_email` NULL ficam ocultas para usuários restritos
(hoje não há nenhuma). A policy de UPDATE de `email_control` (grant só de `reviewed_at`) não mudou.
**Re-varredura ao criar usuários (operacional):** o backfill do
`created_by` é ponto-no-tempo — contas históricas de um usuário criado DEPOIS ficam no sentinela até
uma re-varredura. Ao cadastrar usuário novo, rodar (via Supabase MCP/SQL Editor) para re-atribuir só
as divergentes (idempotente; preserva `updated_by`/`status_changed_by`):

```sql
UPDATE financial_account_control f
   SET created_by = public.resolve_user_for_account(f.sender_email)
 WHERE f.sender_email IS NOT NULL                     -- 🔴 NÃO REMOVER — ver abaixo
   AND f.created_by IS DISTINCT FROM public.resolve_user_for_account(f.sender_email);
```

🔴 **O `sender_email IS NOT NULL` é OBRIGATÓRIO e foi acrescentado em 2026-08-04 — a receita sem
ele é DESTRUTIVA hoje.** A versão original é de 2026-07-10, quando toda conta vinha da extração e
sempre tinha remetente. Depois veio o **CRUD manual** (`/contas`), que grava `created_by` = usuário
logado e **`sender_email` NULL**. Para essas linhas o resolver não tem o que casar e devolve o
**sentinela** — então a cláusula `IS DISTINCT FROM` as considera "divergentes" e o UPDATE
**substituiria o dono real pelo sentinela**, de forma irreversível. Medido em 2026-08-04: **122
contas** nessa situação (121 da barbara, 1 do ricardo), **100% delas criadas à mão**
(`extraction_source IS NULL AND sender_email IS NULL`) — ou seja, a receita antiga apagaria a
autoria de todas, e para um grupo com `sees_only_own_accounts` isso significa **perder a
visibilidade** das próprias contas. A direção da divergência é o oposto do que a receita supõe: não
é "sentinela que deveria virar usuário", é "usuário que viraria sentinela".

**Antes de rodar, confira que só há o caso pretendido** (esperado: `de_sentinela` > 0 e
`de_usuario_real` = 0):

```sql
SELECT count(*) FILTER (WHERE sender_email IS NOT NULL) AS de_sentinela,
       count(*) FILTER (WHERE sender_email IS NULL)     AS de_usuario_real
  FROM financial_account_control f
 WHERE f.created_by IS DISTINCT FROM public.resolve_user_for_account(f.sender_email);
```

(aplicado em 2026-07-10: 40 contas movidas do sentinela p/ estela/rose/bruna após esses usuários
surgirem; estado final 0 divergências **entre contas com remetente** — as de criação manual não
entram na conta e não devem entrar).

**Auditoria de autor (Etapa 2 APLICADA — migration 077):** além do `created_by` (dono), a conta
registra **`updated_by`** (último editor) e **`status_changed_by`/`status_changed_at`** (quem/quando
mudou a situação) — todos UUID → `auth.users`, NOT NULL DEFAULT sentinela. Carimbo pela trigger
**`trg_fac_authorship`** (`fn_stamp_account_authorship`, SECURITY DEFINER): no INSERT `updated_by`/
`status_changed_by` := `created_by`; no UPDATE `updated_by` := `coalesce(auth.uid(), NEW.updated_by,
OLD)` e, quando `status_id` MUDA, `status_changed_by`/`_at` idem. **Cobre os 3 caminhos:** curadoria
REST direta (`authenticated` → `auth.uid()`); Next API PATCH (`contaService.update(raw, userId)` +
`getAuthenticatedUser` no handler → `updated_by` explícito, service_role sem `auth.uid()`); Python
(insert herda `created_by`). O trigger roda **antes** de `trg_fe_status_vencimento` (nome `trg_fac_*`
< `trg_fe_*`), então vê o `status_id` do humano, não o recálculo automático por vencimento.
**Exibição:** o card de detalhe de `/consulta` mostra **Criado por / Última edição por / Situação
alterada por** (e-mail resolvido pela view **`public.app_user`** via `getAppUsers()` — diretório
id→e-mail, grant de **SELECT** para `authenticated`, usuários internos; a ESCRITA foi revogada na
081 — a view rodava como owner e era auto-atualizável, então o grant default virava escrita em
`auth.users`: ver "ESCALADA DE PRIVILÉGIO pela view `app_user`"). `created_by`/`updated_by`/
`status_changed_by`/`status_changed_at` estão no schema de LEITURA de `@sheild/shared` (nunca no
input — carimbados pelo servidor/trigger). **"Última edição por" e "Situação alterada por" são
OMITIDOS quando o autor é o SENTINELA** (`financeiro@otimotex.com.br` / UUID `89ce3055-…` desde a migration 110, o DEFAULT de
`updated_by`/`status_changed_by`) — não representam uma edição de um usuário real (`isSentinelAuthor`
em `Consulta.tsx`, checa por UUID e por e-mail resolvido). "Criado por" permanece sempre.

**Visibilidade do STORAGE por dono (migration 080 — não regredir):** a regra "grupo restrito só vê
as contas em que é dono" vale **também para o bucket** (decisão do usuário, 2026-07-15). A policy da
021 era `USING (bucket_id = 'attachments')` — sem filtro de dono; ela nasceu antes da visibilidade
por grupo, e a 076/079 restringiram conta/anexo mas o bucket ficou aberto. **Verificado com o papel
`authenticated` real:** ester (Comercial) via 36 contas / 26 anexos pela tela e **565 objetos** no
Storage — e a chave é obtível (`GET /api/contas/:id` devolve `source_file`; `/attachments` devolve
`storage_key`; ambas via service_role, que ignora a RLS). A 080 libera o objeto só quando existe
uma linha **visível para o próprio usuário** — `EXISTS` em `financial_account_attachment.storage_key`
**OU** em `financial_account_control.source_file`. As subconsultas são avaliadas como `authenticated`,
então a RLS da 076/079 se aplica DENTRO delas: a policy **herda a regra sem duplicar o predicado de
dono** (visível no `EXPLAIN`: o filtro `auth_group_sees_only_own() OR created_by = …` aparece dentro
do SubPlan). Resultado: Comercial 565→**20** objetos (**0** de contas alheias), Financeiro 565→**233**
(nenhum a menos); `service_role` inalterado.
- **Os DOIS `EXISTS` são necessários:** o de `source_file` cobre o anexo do e-mail cuja linha não
  existe (o registro no reader é NÃO-FATAL) — é o fallback `legacySourceFile` da UI. Sem ele, esse
  anexo pararia de abrir.
- **332 dos 565 objetos ficam invisíveis pela API** (não casam nenhuma linha: PDF que subiu no Passo
  1 e cuja conta nunca foi criada — CT-e ignorado, extração falhou, não-pagável). Já eram
  inalcançáveis pela UI, e o pipeline (`service_role`) segue enxergando para reprocessar.
- **Índice `ix_fac_source_file`** (parcial, `WHERE source_file IS NOT NULL`): a policy roda a CADA
  download; sem ele o `EXISTS` viraria seq scan em `financial_account_control`. O lado do anexo usa
  o `ix_faa_storage_key` da 079. Medido: ~3,7 ms com os dois índices em uso.

**`canSeeConta` — a Next API respeita a visibilidade por dono (`lib/auth.ts` — não regredir):** a
Next API lê/escreve com **service_role, que IGNORA a RLS**, então um usuário de grupo restrito que
forçasse um id alheio recebia (e editava) a conta de outro, embora a tela e o Storage (080) já a
escondessem. `canSeeConta(req, id)` faz a checagem com o **token do próprio usuário** (chave anon +
`setHeader('Authorization')` na query) — a regra fica ONDE já está, na policy da 076, em vez de
reimplementada em TS (2ª fonte de verdade fadada a divergir); quando o blueprint trouxer novas
dimensões (empresa/centro/plano), o guard as herda de graça. Aplicado em **`GET`/`PATCH`
/api/contas/:id** e nas **3 rotas de anexo** (`GET`/`POST` attachments, `POST` upload-url, `DELETE`
attachments/:attId). Responde **404, não 403** — 403 revelaria que a conta existe. Regra: **quem não
pode VER não pode EDITAR**. O `upload-url` sem o guard entregaria uma credencial de ESCRITA no
Storage para a conta de outro.

**Escrita direta por `authenticated` — RLS alinhada à visibilidade (migration 081 — não regredir):**
o frontend escreve DIRETO no PostgREST (sem passar pela Next API, logo sem `canSeeConta`) em dois
pontos: a curadoria inline de `/consulta` (`has_invoice`/`has_bank_slip`/`status_id`) e o "revisado"
de `/emails` (`reviewed_at`). Aí quem manda é a RLS — e as duas policies de UPDATE eram
**`USING (true)`**: um usuário de grupo restrito alterava a curadoria de QUALQUER conta por um PATCH
forjado por id (verificado: ester conseguia marcar NF nas 407 contas; agora **0** alheias). A 081
troca o predicado pelo **mesmo do SELECT** (076 em `financial_account_control`; 078 —
`lower(sender_email) = lower(auth.email())` — em `email_control`), com `WITH CHECK` idêntico.
- **A curadoria por CLIQUE continua funcionando** (requisito do usuário): o predicado é o mesmo do
  SELECT, então o usuário edita exatamente as linhas que a tela mostra. Verificado: ester marca
  NF/BOL/situação nas **36** contas dela e em **0** alheias; barbara (Financeiro, irrestrita) segue
  editando as **412**. `/emails`: 31 próprios × 0 alheios.
- **Os GRANTs por coluna (030/033/068) são intocados** e continuam sendo o que limita o QUE é
  gravável (`has_invoice`/`has_bank_slip`/`status_id`; `reviewed_at`). Um `REVOKE UPDATE` nessas
  duas tabelas os derrubaria e quebraria a curadoria — por isso a 081 revoga só `INSERT, DELETE`
  ali (e é por isso que a 057 não as tocou).

**ESCALADA DE PRIVILÉGIO pela view `app_user` — FECHADA (migration 081; a mais grave até aqui):**
a view da 077 (`SELECT id, email FROM auth.users`) tem `security_invoker = false` — roda como o
OWNER e ignora a RLS de `auth.users`, o que é **necessário** para o `/consulta` resolver o e-mail do
autor. O problema era o outro lado: view simples é **auto-atualizável** (`is_updatable = YES`) e o
Supabase concede grants DEFAULT de escrita ao papel. Verificado com o papel `authenticated` real —
ester (Comercial, o grupo MAIS restrito) rodou
`UPDATE public.app_user SET email='invadido@…' WHERE email='ricardo@sheild.com.br'` e alterou **1
linha em `auth.users`**: qualquer usuário logado podia trocar o e-mail de qualquer outro (inclusive
do Administrador) e tomar a conta via "esqueci minha senha". O `DELETE` só não passou por uma FK
acidental (`status_changed_by`) — usuário sem contas seria apagável. Fix: `REVOKE INSERT, UPDATE,
DELETE ON public.app_user FROM authenticated, anon` (a view é read-only por natureza; o
`security_invoker=false` PERMANECE, senão o autor some da tela — `auth.users` não tem policy para
`authenticated`). Verificado: `42501 permission denied for view app_user`, e a leitura segue (12
usuários). **Lição:** toda VIEW nova sobre `auth.*`/dado sensível precisa de REVOKE explícito de
escrita — o default do Supabase é permissivo e a RLS da tabela-base NÃO protege uma view
`security_invoker = false`.

**Escala futura (fora das Etapas 1–2):** `auth_is_admin()` (bypass por papel) e as dimensões de
visibilidade do blueprint (`docs/design/permissoes-por-grupo.md`: empresa/centro/plano).

**Erros não vazam detalhe interno — o contrato é a ORIGEM do erro, não o formato (segurança §3
M-2; endurecido em 2026-07-29):** os route handlers usam `failFromError(e, '<tag>')`
(`lib/response.ts`), que **só ecoa a mensagem quando o erro é um `ApiServiceError`**
(`lib/api-error.ts`) com status < 500. Qualquer outra coisa — incluindo erro de terceiro — vira
`'Erro interno ao processar a solicitação'` **500**, com o detalhe indo só para o `console.error`.
Não reintroduzir `fail(e.message, 500)` nos handlers.

> **Por que deixou de ser duck-typing (não regredir):** a regra antiga era "tem `.status` numérico
> < 500? ecoa a mensagem" — e isso é **verdadeiro para erros de bibliotecas de terceiros**, que
> também carregam `status`. Medido: `AuthError` (`@supabase/auth-js`) = **400** / "Invalid login
> credentials"; `StorageApiError` (`@supabase/storage-js`) = **404** / "Object not found". Bastava
> um `catch` novo repassar o erro cru para o usuário do financeiro ver texto em inglês do provider,
> silenciosamente e sem teste vermelho. Os services já convertiam esses erros por disciplina, mas
> disciplina não é contrato. Vale ainda mais para a **Fase 2 do chat**, cujos erros do
> `@anthropic-ai/sdk` são 429/401/400 (§17.9 do doc de arquitetura).
>
> **Ao criar uma classe de erro de service nova, ela DEVE estender `ApiServiceError`** — senão a
> mensagem curada nunca chega ao cliente (vira 500 genérico). As 12 existentes já estendem.
>
> **Mock de teste também estende a base.** Os 23 arquivos de teste de rota que redefiniam
> `class XServiceError extends Error` dentro do `vi.mock` foram migrados para
> `extends ApiServiceError` via `vi.importActual('@/lib/api-error')` — um mock que duplica o
> contrato em vez de reusá-lo fica desatualizado quando o contrato muda (foi exatamente o que
> aconteceu: 36 testes quebraram na migração). `failFromError` tem cobertura própria em
> `lib/response.test.ts`, incluindo os dois formatos de erro de terceiro.
