from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any


@dataclass
class Conta:
    fornecedor: str
    valor: Decimal
    vencimento: str
    codigo_barras: str
    assunto_email: str


def _extrair_campo(texto: str, campo: str) -> str:
    padrao = re.compile(rf"{re.escape(campo)}\s*:\s*(.+)", re.IGNORECASE)
    match = padrao.search(texto)
    if not match:
        raise ValueError(f"Campo obrigatório ausente: {campo}")
    return match.group(1).strip()


def _parse_valor(valor_str: str) -> Decimal:
    valor_limpo = valor_str.replace("R$", "").replace(".", "").replace(",", ".").strip()
    try:
        valor = Decimal(valor_limpo)
    except InvalidOperation as exc:
        raise ValueError(f"Valor inválido: {valor_str}") from exc
    if valor <= 0:
        raise ValueError(f"Valor deve ser positivo: {valor_str}")
    return valor


def extrair_conta_de_email(email: dict[str, Any]) -> Conta:
    corpo = str(email.get("corpo", ""))
    assunto = str(email.get("assunto", ""))

    fornecedor = _extrair_campo(corpo, "Fornecedor")
    valor = _parse_valor(_extrair_campo(corpo, "Valor"))
    vencimento = _extrair_campo(corpo, "Vencimento")
    codigo_barras = _extrair_campo(corpo, "Codigo de Barras")

    date.fromisoformat(vencimento)
    if not re.fullmatch(r"(?:\d{44}|\d{48})", codigo_barras):
        raise ValueError("Código de barras inválido: use 44 ou 48 dígitos")

    return Conta(
        fornecedor=fornecedor,
        valor=valor,
        vencimento=vencimento,
        codigo_barras=codigo_barras,
        assunto_email=assunto,
    )


def automatizar_recebimento_e_pagamentos(emails: list[dict[str, Any]]) -> dict[str, Any]:
    contas: list[Conta] = []
    codigos_processados: set[str] = set()

    for email in emails:
        conta = extrair_conta_de_email(email)
        if conta.codigo_barras in codigos_processados:
            continue
        codigos_processados.add(conta.codigo_barras)
        contas.append(conta)

    hoje = date.today()
    pagamentos = []
    for conta in sorted(contas, key=lambda c: c.vencimento):
        vencimento = date.fromisoformat(conta.vencimento)
        status = "pago" if vencimento <= hoje else "agendado"
        pagamentos.append(
            {
                "fornecedor": conta.fornecedor,
                "valor": f"{conta.valor:.2f}",
                "vencimento": conta.vencimento,
                "codigo_barras": conta.codigo_barras,
                "origem": conta.assunto_email,
                "status": status,
            }
        )

    total = sum((conta.valor for conta in contas), Decimal("0"))
    return {
        "quantidade_contas": len(contas),
        "valor_total": f"{total:.2f}",
        "pagamentos": pagamentos,
    }


def _carregar_emails(caminho: Path) -> list[dict[str, Any]]:
    dados = json.loads(caminho.read_text(encoding="utf-8"))
    if not isinstance(dados, list):
        raise ValueError("Arquivo de entrada deve conter uma lista de emails")
    return dados


def _salvar_saida(caminho: Path, dados: dict[str, Any]) -> None:
    caminho.write_text(json.dumps(dados, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Automatiza recebimento e pagamento de contas a partir de emails."
    )
    parser.add_argument("entrada", type=Path, help="JSON com emails recebidos")
    parser.add_argument("saida", type=Path, help="JSON de pagamentos processados")
    args = parser.parse_args()

    emails = _carregar_emails(args.entrada)
    resultado = automatizar_recebimento_e_pagamentos(emails)
    _salvar_saida(args.saida, resultado)


if __name__ == "__main__":
    main()
