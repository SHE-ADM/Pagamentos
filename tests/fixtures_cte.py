"""Fixture compartilhada: trecho REAL de uma fatura agregada BRASPRESS.

POR QUE UM MODULO, E NAO A CONSTANTE COPIADA NOS DOIS TESTES
    Dois arquivos precisam dela — `test_cte_content.py` (parser + gancho) e
    `test_fiscal_document_hook.py` (fluxo de topo). Copiada, as duas versoes divergem no
    primeiro ajuste e passam a testar faturas diferentes com o mesmo nome; e o oraculo do
    SUB-TOTAL so vale enquanto as linhas e o total forem coerentes entre si, o que uma copia
    editada pela metade quebra em silencio.

    Nao e `conftest.py` de proposito: conftest e para fixtures do pytest (injecao por
    parametro), e estes testes sao `unittest.TestCase`, que nao as recebe.

PROCEDENCIA: fatura 2607128724, e-mail "ENC: 1o. ENVIO - Acesso a faturas via WEB - BRASPRESS"
(objeto `atendimento_ENC_1o_ENVIO_-_Acesso_a_fatura_20260721_link.pdf` no bucket). Os tres
conhecimentos, as chaves e o SUB-TOTAL sao os do PDF; so o cabecalho foi encurtado.

Dado publico de conhecimento de transporte (chave, rota, peso) — sem segredo.
"""

# O emissor grafa o proprio nome das DUAS formas no MESMO documento ("BRASPRES" na razao
# social, "braspress" no rodape) — as duas ficam aqui porque o detector tolera ambas, e uma
# fixture com so uma delas ja mascarou esse detalhe uma vez.
FATURA_BRASPRESS = """Matriz: ROD PRESIDENTE DUTRA KM 222,500 S/N
CNPJ 48.740.351/0001-65 Insc. Est.796621736119
Cliente: TEXTIL E CONFECCOES OTIMOTEX LTDA CNPJ: 47.273.917/0001-23
BRASPRES TRANSPORTES URGENTES LTDA - CNPJ: 48.740.351/0001-65
www.braspress.com.br - Central de atendimento Cobranca Braspress: 0800-775-3333
Fatura de Conhecimento(s) de transporte eletronico, acesse o site abaixo e informe a(s) chave(s)
NUMERO PERCURSO DATA PESO NOTA VRL. VRL. DESTINATARIO
AWB ORIG DEST FISCAL MERC. FRETE
005709378 CCT RIO 14/07/2026 96,00 248632 24.156,61 652,60 HANDRED STUDIO COMERCIO LTDA
Chave CTe 35260748740351011442570000057093781966739743
005712210 CCT RIO 16/07/2026 3,00 248658 511,20 148,70 HANDRED STUDIO COMERCIO LTDA
Chave CTe 35260748740351011442570000057122101176557511
005710879 CCT V2C 15/07/2026 8,28 248586 2.300,40 133,87 HAGAEF CONFECCOES EIRELI
Chave CTe 35260748740351011442570000057108791138923112
SUB-TOTAL 107,28 26.968,21 935,17
TOTAL BRUTO R$ PESO CREDIT SUB-TOTAL ICMS ST ICMS QTD AW DESCONTO VALOR LIQUIDO R$
935,17 107,28 0,00 935,17 0,00 0,00 3 0,00 935,17
"""

# As tres chaves da fatura, na ordem impressa.
CHAVES = (
    "35260748740351011442570000057093781966739743",
    "35260748740351011442570000057122101176557511",
    "35260748740351011442570000057108791138923112",
)

# Totais impressos no SUB-TOTAL — o oraculo do parser.
SUBTOTAL_PESO = "107.28"
SUBTOTAL_FRETE = "935.17"
