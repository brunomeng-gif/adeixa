# Adeixa

Protótipo web para atores ensaiarem o texto sozinhos: o app fala as deixas dos
outros personagens e escuta a sua fala para saber quando continuar.

## Online

**https://brunomeng-gif.github.io/adeixa/**. Cada `git push` na branch `main`
publica de novo automaticamente (GitHub Actions → Pages).

No celular:
- **Android**: use o Chrome. Pelo menu ⋮, escolha "Adicionar à tela inicial". Para
  evitar os bipes do sistema, o app percebe o fim das suas falas só pelo volume da
  voz. A opção "Reconhecer o texto que eu falo" fica desligada por padrão.
- **iPhone**: use o Safari. Pelo botão Compartilhar, escolha "Adicionar à Tela de Início". O reconhecimento
  de voz do iPhone é menos confiável. Se falhar, siga com o botão "Próxima".
- Use fone de ouvido e permita o microfone quando o navegador pedir.
- Para ver de onde vem algum atraso, abra o app com `?debug` no fim do endereço
  (https://brunomeng-gif.github.io/adeixa/?debug). A cada deixa aparecem os tempos medidos.

As peças e gravações ficam salvas no aparelho em que foram importadas. Para
usar no celular, importe o PDF lá também.

## Como rodar no computador

Precisa do [Node.js](https://nodejs.org) instalado.

```bash
npm install
npm start
```

Abra **http://localhost:5173** no **Chrome** ou no **Edge**. O reconhecimento de
voz só funciona nesses dois navegadores e precisa de internet. No Edge, as vozes
em português costumam soar melhor.

Use fone de ouvido, para o microfone não captar as deixas.

## Fluxo

1. **Importar**: PDF ou TXT com o nome do personagem antes de cada fala. Também dá para colar o texto.
2. **Revisar**: confira personagens e falas. Para juntar nomes com erro de
   digitação (ex.: EPAMINODAS → EPAMINONDAS), renomeie um igual ao outro.
3. **Configurar**: escolha seu papel, as cenas, como ver suas falas (primeiras três
   palavras, texto completo ou ocultar texto) e a voz de cada personagem.
4. **Ensaiar**: o app fala as deixas e escuta você. Diga **"texto"** (ou toque em
   💡) para receber o ponto. A barra de espaço avança manualmente.
   Na barra de baixo dá para ajustar, durante o ensaio, a **velocidade das
   deixas** e o **tempo de resposta** (quanto o app espera depois que você
   termina de falar). As mudanças valem a partir da próxima fala.
   O app **aprende o seu ritmo** (quanto tempo de voz cada fala leva) e, a cada
   ensaio, acerta melhor o fim das falas. Se a deixa vier cedo e você tocar em
   "⟲ Deixa", aquela medição é descartada. Dá para zerar em "Esquecer ritmo".
5. **Gravar** (opcional): cada ator grava as próprias falas. Em "Exportar
   gravações", gera um arquivo para mandar ao elenco, que faz "Importar
   gravações". As falas gravadas substituem a voz sintética.

Tudo fica salvo no próprio navegador (IndexedDB). Nada é enviado a servidor
nenhum, exceto o áudio do reconhecimento de voz, que o Chrome e o Edge processam
na nuvem.

## Estrutura

| Arquivo | Função |
|---|---|
| `server.js` | servidor estático local |
| `public/js/parser.js` | separa o texto em cenas, falas e rubricas (PDF em colunas ou texto `NOME: fala`) |
| `public/js/pdf-extract.js` | lê o PDF com pdf.js, mantendo a posição de cada trecho |
| `public/js/speech.js` | reconhecimento de voz e comparação com o texto esperado |
| `public/js/voices.js` | vozes sintéticas e reprodução das gravações |
| `public/js/rehearsal.js` | motor do ensaio (deixas, sua vez, pausar, voltar) |
| `public/js/app.js` | telas |
| `public/js/rhythm.js` | aprende o ritmo do ator (tempo de voz por palavra e por fala) |
| `public/js/vad.js` | medidor de volume do microfone (percebe na hora quando o ator para de falar) |
| `test/parse-pdf.mjs` | roda o separador no PDF da peça e mostra o resultado |
| `test/timing.mjs` | simula o tempo de resposta das deixas (computador e Android) |

## Próximos passos possíveis

- Vozes neurais melhores (ElevenLabs, Azure) e clonagem de voz com consentimento.
- Servidor para o elenco compartilhar peça e gravações sem trocar arquivos.
- App nativo (melhor controle de áudio, uso offline).
