> **Portuguese edition (Tier-2 overview)** — machine-assisted translation, unified by the i18n PM. **The Chinese original governs.**
> Source baseline: 2026-10-15 · Glossary: [../GLOSSARY.md](../GLOSSARY.md) · Governance: [../README.md](../README.md)

# YuanBingKe (ybkk-AIOS) — gestão de recursos de IA para a empresa

**Posicionamento:** uma plataforma de gestão de recursos de IA para a empresa, construída sobre a
arquitetura dsh "Everything is a plugin" (tudo é um plugin).

YuanBingKe (nome de marca original em chinês: 元冰可, código de produto ybkk-AIOS) é uma plataforma
empresarial auto-hospedada (self-hosted) para a gestão centralizada de recursos de IA. Assenta na
arquitetura do dsh (DeepSeek Harness). Seis tipos de ativos são geridos sob uma única identidade
(IAM/OIDC SSO), um único sistema de permissões, uma única medição de utilização e uma única auditoria.

## O problema e a solução

Em muitas organizações, a IA cresce em ilhas: serviços MCP, skills, agentes e aplicações de IA operam
em silos — contas dispersas, permissões pouco claras, custos de modelos opacos e sem um rasto de
auditoria utilizável. Nem os sistemas de informação nem a conformidade conseguem responder com certeza
a quem usa cada recurso de IA, quanto custa internamente e que riscos transporta.

O YuanBingKe responde com um plano de controlo unificado: uma identidade, um modelo de permissões, uma
medição de utilização transparente e um rasto de auditoria contínuo para todos os ativos de IA. Cada
alteração percorre etapas definidas de validação e aprovação (rascunho → validação → canary →
lançamento geral) e cada ação fica registada de forma verificável. Por ser auto-hospedada, a
plataforma permanece dentro do perímetro informático da empresa.

## Seis tipos de ativos, uma base comum

- **Serviços MCP** — implantação versionada com canary, releases imutáveis e gateway de tokens com granularidade por ferramenta.
- **Skills** — capacidades validadas do mercado de skills, publicadas por versão após análise estática e aprovação em dois níveis.
- **Agentes** — agentes registados com credenciais de máquina, papel organizacional e níveis de autonomia definidos.
- **Aplicações de IA** — aplicações internas e externas com SSO, métricas (PV/UV/DAU) e visibilidade de custos.
- **Rotas de modelos** — acesso a modelos através do gateway dedicado, com governança de canais.
- **Armazenamento NAS** — ficheiros como classe de ativo gerida, com permissões de dados e downloads assinados.

## Capacidades em destaque

- **IAM unificado**: árvore organizacional multinível, papéis e grupos de utilizadores, matriz de
  permissões; fornecedor OIDC (RS256/JWKS/PKCE) como SSO para as aplicações de IA ligadas, com porta
  de entrada em produção (go-live gate).
- **Implantação MCP com controlos**: fluxo draft → validate → canary → full rollout, versões
  imutáveis, rollback num clique, gateway de tokens com grupos de permissões, granularidade por
  ferramenta e restrição só de leitura, circuit breaking e monitorização P95.
- **Mercado de skills com cadeia de controlo**: submissão → análise estática (rejeição automática de
  código malicioso e fuga de segredos) → aprovação em dois níveis → publicação versionada;
  verificação de contratos por assinatura Ed25519.
- **Agentes com autonomia governada**: credenciais de máquina, cadeia de tokens on-behalf-of,
  topologia de orquestração legível num relance; níveis de autonomia A0–A3 e invocações nomeadas A2A
  entre agentes.
- **Orquestração de fluxos de trabalho (flow-core)**: orquestração TF com máquina de estados por
  passo, biblioteca de modelos e contextPack, acompanhamento de SLA e progresso, linha temporal
  Gantt.
- **Gateway de acesso a modelos (modelgw)**: encaminhamento real compatível com OpenAI (nunca
  respostas inventadas), governança de canais com encaminhamento por níveis, cadeias de recurso
  (fallback) e disjuntor orçamental (budget circuit breaker).
- **Medição transparente da utilização + relatório FinOps**: pipeline de medição idempotente,
  instantâneo a preço zero, transposição interna de custos por departamento × modelo (cost
  pass-through), custo por DAU, exportação CSV num clique (UTF-8 BOM, compatível com Excel).
- **Hub de execução e trabalhadores digitais (domínio workforce)**: árvores de objetivos com
  alinhamento de metas, ciclo de batimento de 30 s, bloqueios de execução (CAS), agendamento de
  rotinas por intervalo/cron/webhook, autorizações de trabalho temporárias (permits) e ciclo de
  entrega com aceitação humana, incluindo o desbloqueio sujeito a aprovação L4.
- **NAS com permissões de dados**: ligação através de um gateway de ficheiros MCP (sem acesso direto
  às API privadas do DSM), RBAC baseado na localização organizacional e na hierarquia de papéis com
  negação por omissão, URL de download assinados e acompanhamento da propriedade dos ficheiros.
- **Plataforma como servidor MCP**: `POST /mcp` expõe mais de 40 ferramentas de operação a qualquer
  cliente MCP (ZCode, Claude, Cursor, etc.), com token Bearer e pontos de permissão por ferramenta.

## Modelo comercial

O YuanBingKe é proposto segundo o modelo **"equipa + ativos de domínio"**: a fixação de preços depende do
número de equipas ativadas e dos pacotes de ativos de domínio escolhidos (pacotes setoriais, pacotes
de cenários), e não de uma licença global de plataforma. Para a indústria transformadora está
disponível uma **entrega privada on-premises em formato de projeto**.

A plataforma não incorpora deliberadamente qualquer semântica de faturação ou de liquidação: o livro
de preços funciona como instantâneo a preço zero (campo `charge` sempre 0) e mostra apenas
transparência de utilização e transposição interna de custos (cost pass-through). Carteira, recargas
e partilha de receitas foram retirados por completo do produto.

## Implantação e operação

- **Auto-hospedado, base leve**: Node ≥ 22.6, TypeScript nativo sem passo de compilação; ponto de
  acesso por omissão `http://127.0.0.1:7300`.
- **Duas formas de instalação**: como bundle dsh (`dsh plugin --profile web add github:01men/ybkkasi`,
  25 entradas de plugins, plano de dados sob o prefixo `/rq`) ou como processo autónomo com
  `npm install && npm start`.
- **Modo de demonstração para avaliação**: `DEMO_SEED=1 npm start` injeta dados de demonstração.
  Destinado apenas a ambientes de demonstração — manter desativado em produção.
- **Autoatualização da plataforma**: verificação automática de versões (por omissão a cada 24 h,
  desativável com `DSH_UPDATE_AUTO_CHECK=off`), atualização a partir da consola（控制台）com dry-run e
  auditoria; espelhos privados através de `DSH_UPDATE_API_BASE` / `DSH_UPDATE_RAW_BASE`. Pontos de
  permissão: `platform.update.read`, `platform.update.apply`.
- **Operação e rastreabilidade**: CLI `node cli/dshctl.mjs`, eventos de utilização retidos 730 dias
  por omissão (`USAGE_RETENTION_DAYS`), quatro classes de registos de auditoria, exportação CSV de
  relatórios de utilização e FinOps.
- **Porta de qualidade**: `npm run selftest` executa testes de ponta a ponta numa instância isolada
  (mais de 1.380 verificações, conforme a última execução).

## Porque faz sentido para Portugal e para a África lusófona

- **Portugal: RGPD através do auto-hospedamento**: o self-hosting e a entrega privada on-premises são
  o caminho para a residência dos dados — a plataforma corre na infraestrutura própria, sem
  dependência de nuvem imposta; um processo de DPA está na folha de rota.
- **Angola e Moçambique: operação on-premises em redes de baixa largura de banda**: o formato de
  projeto com entrega privada, a documentação em Markdown puro e a atualização via espelhos privados
  adaptam-se a ambientes com conectividade limitada, mantendo os dados no local.
- **Governança verificável**: aprovações em dois níveis, âncoras de evidência de auditoria,
  aprovações obrigatórias L4 e autorização por cenário com fail-closed apoiam os controlos internos
  exigidos por auditorias e grupos empresariais.

> Nota de honestidade: estes pontos descrevem capacidades técnicas e opções de entrega, não
> certificações — SOC 2 / ISO 27001 não foram obtidas e constam da folha de rota. Antes de entrar em
> qualquer mercado de Portugal ou da África lusófona é necessária uma revisão de conformidade com
> aconselhamento jurídico local; este documento não constitui aconselhamento jurídico.

## Nota sobre o idioma da interface

Desde a versão de 2026-10-16, a interface de execução (consola（控制台）, painéis, portal, saídas de CLI,
notificações, mensagens de erro) traz um seletor de idioma integrado: chinês simplificado
(predefinição), inglês (EUA) e japonês. A troca é feita pelo seletor na barra superior; a preferência
é guardada no navegador (`rq_lang`). A CLI segue `--lang` ou `DSHCTL_LANG`. Qualquer texto ainda não
coberto por um dicionário retorna graciosamente ao chinês. Os nomes originais em chinês entre
parênteses que acompanham os termos em português nestes documentos continuam úteis — por exemplo,
para capturas de ecrã, implantações on-prem fixadas em chinês e rótulos próximos ao protocolo; a
tradução do navegador também continua a funcionar.

## Para saber mais

- [Edição completa em inglês — panorama do produto](../en/README.md)
- [Guia de iniciação rápida (inglês)](../en/getting-started.md)
- [Introdução ao produto (inglês)](../en/product-introduction.md)
- [Governança i18n e níveis de idioma](../README.md)

---

*Esta página é uma síntese Tier-2 com tradução assistida por máquina. Em caso de divergência, prevalece o original chinês; a edição completa em inglês serve de referência internacional.*
