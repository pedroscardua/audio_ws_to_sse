import express, { Request, Response } from 'express';
import * as http from 'http';
import WebSocket from 'ws';
import cors from 'cors';
import * as lamejs from '@breezystack/lamejs';

const app = express();

// Add CORS middleware
app.use(cors({
  origin: ['http://localhost:57061', 'http://localhost:3002','https://app.audracs.com.br'],
  methods: ['GET'],
  credentials: true
}));

const server = http.createServer(app);
const port = 3004;
// Configurações de áudio e MP3
const sampleRate = 32000;      // Taxa de amostragem (ex.: 32000 Hz)
const channels = 1;            // Mono
const bitRate = 128;           // Qualidade MP3 em kbps (ex.: 128 kbps)
const CHUNK_DURATION_SECONDS = 5;  // Agrupar 1 segundo de áudio

// Definindo o corte do filtro passa-baixa (ex.: 3000 Hz para reduzir ruídos agudos)
const lowPassCutoff = 1000;
// Variável para manter o último valor filtrado entre os chunks
let filterState = 0;

/**
 * Endpoint SSE que:
 * 1. Conecta a um WebSocket remoto (informado via parâmetro wsURL)
 * 2. Recebe e acumula os chunks de áudio PCM (16 bits)
 * 3. A cada 1 segundo, converte o áudio acumulado para MP3 (usando lamejs)
 * 4. Envia o MP3 em Base64 via SSE para o cliente
 */
app.get('/stream', (req, res) => {
  const wsURL1 = req.query.url as string;
  let retryCount = 0;
  let MAX_RETRIES = 30;
  let RETRY_DELAY = 500;

  if (!wsURL1) {
    res.status(400).send('Parâmetro id é obrigatório.');
    return;
  }

  const wsURL = wsURL1.replace('audracs.com.br', 'vapi.ai');
  
  async function connectWebSocket() {
    try {
      const response = await fetch(wsURL.replace('ws', 'http'));
      
      if (response.status === 404) {
        res.status(404).json({ 
          error: 'WebSocket endpoint not found',
          details: 'Resource does not exist'
        });
        return;
      }
      
      if (response.status === 400 && retryCount < MAX_RETRIES) {
        retryCount++;
        console.log(`Retrying connection attempt ${retryCount} of ${MAX_RETRIES}`);
        setTimeout(connectWebSocket, RETRY_DELAY);
        return;
      }

      // If status is OK, proceed with WebSocket connection
      const remoteWs = new WebSocket(wsURL);
      remoteWs.binaryType = 'arraybuffer';

    // Add connection timeout
    const connectionTimeout = setTimeout(() => {
      if (remoteWs.readyState !== WebSocket.OPEN) {
        res.status(504).json({ error: 'WebSocket connection timeout' });
        remoteWs.close();
      }
    }, 10000); // 10 seconds timeout

    remoteWs.on('open', () => {
      clearTimeout(connectionTimeout);
      console.log('Connected to remote WebSocket:', wsURL);
      
      // Only setup SSE after successful connection
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
    });

    remoteWs.on('error', (error: any) => {
      if (error.code === 400 && retryCount < MAX_RETRIES) {
        retryCount++;
        console.log(`Retrying connection attempt ${retryCount} of ${MAX_RETRIES}`);
        setTimeout(connectWebSocket, RETRY_DELAY);
      } else if (error.code === 404) {
        console.error('Resource not found (404):', error);
        res.status(404).json({ 
          error: 'WebSocket resource not found',
          details: error.message 
        });
        remoteWs.close();
      } else {
        console.error('WebSocket error:', error);
        res.status(502).json({ 
          error: 'WebSocket connection failed',
          details: error.message 
        });
      }
    });

    remoteWs.on('close', (code, reason) => {
      console.log(`WebSocket closed with code ${code} and reason: ${reason}`);
    
      // Determina o statusCode com base na mensagem de reason
      let statusCode = 503; // valor padrão
      if (reason.includes('404')) {
        statusCode = 404;
      } else if (reason.includes('400')) {
        statusCode = 400;
      }
    
      if (statusCode === 400 && retryCount < MAX_RETRIES) {
        retryCount++;
        console.log(`Retrying connection attempt ${retryCount} of ${MAX_RETRIES}`);
        setTimeout(connectWebSocket, RETRY_DELAY);
      } else if (statusCode === 404) {
        res.status(404).json({ 
          error: 'WebSocket resource not found',
          code,
          reason 
        });
      } else {
        res.status(statusCode).json({ 
          error: 'WebSocket connection failed',
          code,
          reason 
        });
      }
    });

    
    

    // Buffer para armazenar os chunks de áudio (cada chunk é um Int16Array)
    let audioBuffer: Int16Array[] = [];

    // Ao receber dados do WebSocket, converte-os para Int16Array, filtra e acumula no buffer
    remoteWs.on('message', (data) => {
      try {
        if (data instanceof ArrayBuffer) {
          // Converte o ArrayBuffer PCM para Int16Array (PCM 16-bit little-endian)
          const int16Chunk = convertPCMToInt16(data);
          // Aplica o filtro passa-baixa para reduzir ruídos agudos
          const { filtered, lastValue } = applyLowPassFilter(int16Chunk, sampleRate, lowPassCutoff, filterState);
          filterState = lastValue; // Atualiza o estado para o próximo chunk
          audioBuffer.push(filtered);
        }
      } catch (error) {
        console.error('Erro ao processar dados de áudio:', error);
        res.write(`data: ${JSON.stringify({ error: 'Erro no processamento de áudio' })}\n\n`);
      }
    });

    // Se o cliente SSE se desconectar, encerra a conexão com o WebSocket remoto
    req.on('close', () => {
      console.log('Cliente SSE desconectado');
      remoteWs.close();
    });

    // A cada CHUNK_DURATION_SECONDS (1 segundo), processa os chunks acumulados,
    // convertendo-os para MP3 e enviando via SSE
    setInterval(async () => {
      if (audioBuffer.length > 0) {
        try {
          const mp3Base64 = await convertChunksToMp3(audioBuffer);
          // Log buffer info
          console.log('Audio buffer chunks:', audioBuffer.length);
          console.log('First chunk size:', audioBuffer[0]?.length);
          
          audioBuffer = [];
          if (mp3Base64) {
            res.write(`data: ${JSON.stringify({ mp3: mp3Base64 })}\n\n`);
          }
        } catch (error) {
          console.error('Detailed MP3 conversion error:', error);
          res.write(`data: ${JSON.stringify({ error: 'Erro na conversão para MP3' })}\n\n`);
        }
      }
    }, CHUNK_DURATION_SECONDS * 1000);
    } catch (error: any) {
      if (retryCount < MAX_RETRIES) {
        retryCount++;
        console.log(`Connection attempt failed. Retrying ${retryCount}/${MAX_RETRIES} in ${RETRY_DELAY}ms`);
        setTimeout(connectWebSocket, RETRY_DELAY);
        return;
      }
      console.error('Max retries reached:', error);
      res.status(503).json({
        error: 'Connection failed after max retries',
        details: error.message
      });
    }
  }

  connectWebSocket();
  });

server.listen(port, () => {  console.log(`Servidor rodando em http://localhost:${port}`);
});

/**
 * Função que converte um ArrayBuffer contendo PCM 16-bit em um Int16Array.
 * Cada amostra (2 bytes) é interpretada como um inteiro de 16 bits (little-endian).
 */
function convertPCMToInt16(arrayBuffer: ArrayBuffer): Int16Array {
  const bytesPerSample = 2;
  const totalSamples = arrayBuffer.byteLength / bytesPerSample;
  const dataView = new DataView(arrayBuffer);
  const int16Array = new Int16Array(totalSamples);

  for (let i = 0; i < totalSamples; i++) {
    int16Array[i] = dataView.getInt16(i * bytesPerSample, true);
  }

  return int16Array;
}

/**
 * Função que concatena os chunks de PCM acumulados e os converte para MP3.
 * O resultado é uma string Base64 representando o arquivo MP3.
 */
async function convertChunksToMp3(pcmChunks: Int16Array[]): Promise<string | null> {
  if (pcmChunks.length === 0) return null;

  const mp3Encoder = new lamejs.Mp3Encoder(channels, sampleRate, bitRate);
  const mp3Data: Uint8Array[] = [];

  // Concatena todos os chunks em um único Int16Array
  const totalLength = pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const pcmData = new Int16Array(totalLength);
  let offset = 0;
  for (const chunk of pcmChunks) {
    pcmData.set(chunk, offset);
    offset += chunk.length;
  }

  // Divide o PCM em blocos para a codificação MP3 (1152 amostras por bloco)
  const blockSize = 1152;
  for (let i = 0; i < pcmData.length; i += blockSize) {
    const block = pcmData.subarray(i, i + blockSize);
    const mp3buf = mp3Encoder.encodeBuffer(block);
    if (mp3buf.length > 0) {
      mp3Data.push(new Uint8Array(mp3buf));
    }
  }

  // Finaliza a codificação MP3
  const mp3Final = mp3Encoder.flush();
  if (mp3Final.length > 0) {
    mp3Data.push(new Uint8Array(mp3Final));
  }

  // Combina todos os pedaços MP3 em um único Uint8Array
  const totalMp3Length = mp3Data.reduce((sum, arr) => sum + arr.length, 0);
  const mp3Combined = new Uint8Array(totalMp3Length);
  let pos = 0;
  for (const arr of mp3Data) {
    mp3Combined.set(arr, pos);
    pos += arr.length;
  }

  // Converte o buffer MP3 para Base64
  return Buffer.from(mp3Combined).toString('base64');
}

/**
 * Função que aplica um filtro passa-baixa simples usando um filtro de primeira ordem.
 * Utiliza a fórmula:
 *   y[n] = α * x[n] + (1 - α) * y[n - 1]
 * onde:
 *   dt = 1/sampleRate
 *   RC = 1/(2π * cutoff)
 *   α = dt / (RC + dt)
 * 
 * @param data - O array de PCM (Int16Array) que será filtrado
 * @param sampleRate - Taxa de amostragem (Hz)
 * @param cutoff - Frequência de corte do filtro (Hz)
 * @param prevValue - Valor de saída anterior (para continuidade entre chunks)
 * @returns Um objeto contendo o array filtrado e o último valor filtrado para continuidade
 */
function applyLowPassFilter(data: Int16Array, sampleRate: number, cutoff: number, prevValue: number): { filtered: Int16Array, lastValue: number } {
  const dt = 1 / sampleRate;
  const RC = 1 / (2 * Math.PI * cutoff);
  const alpha = dt / (RC + dt);

  const filtered = new Int16Array(data.length);
  let previous = prevValue;
  for (let i = 0; i < data.length; i++) {
    // Calcula o valor filtrado; usamos Math.round para manter valores inteiros
    const filteredSample = alpha * data[i] + (1 - alpha) * previous;
    filtered[i] = Math.round(filteredSample);
    previous = filteredSample;
  }
  return { filtered, lastValue: previous };
}