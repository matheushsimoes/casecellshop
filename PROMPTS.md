# Uso de IA

A IA foi usada como par de programação: para acelerar a escrita, levantar modos de falha e revisar código. As decisões de arquitetura e o que foi aceito ou rejeitado estão registrados abaixo.


## Prompts relevantes

1. **Modos de falha**
   > "Liste os modos de falha de um checkout que reserva estoque, grava o pedido e publica numa fila para um worker faturar num ERP lento. Para cada um: efeito para o cliente, para o negócio e mitigação."

2. **Cache**
   > "Implemente em TypeScript, sem dependências, um cache com TTL e jitter, single-flight por chave, stale-while-revalidate e stale-if-error. Exponha métricas de hit, miss, stale e coalesced."

3. **Teste de concorrência**
   > "Escreva um teste com node:test que dispare 100 checkouts HTTP simultâneos para um SKU com estoque 10 e prove que não há overselling. Inclua um teste de controle que prove que o teste detectaria uma implementação check-then-act."

4. **Revisão crítica**
   > "Revise este worker procurando: efeito duplicado se a mesma mensagem chegar duas vezes, retry de erro permanente, timeout que esconde um faturamento que deu certo, e estoque que fica preso quando o pedido falha."

5. **Contrato**
   > "Gere o OpenAPI 3 destas rotas com schemas de sucesso e de erro no formato RFC 7807, incluindo os headers Idempotency-Key, Location, x-cache e x-correlation-id."

## O que foi revisado ou rejeitado

