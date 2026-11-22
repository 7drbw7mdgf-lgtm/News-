<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');

function reply(int $status, array $body): void
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    header('Allow: GET');
    reply(405, ['error' => 'GET only']);
}

if (($_GET['health'] ?? '') === '1') {
    $hasCurl = function_exists('curl_init');
    reply($hasCurl ? 200 : 503, ['ok' => $hasCurl, 'curl' => $hasCurl, 'service' => 'indian-express-reader']);
}

$input = $_GET['url'] ?? '';
if (!is_string($input) || strlen($input) > 2048) {
    reply(400, ['error' => 'Invalid article URL']);
}

$parts = parse_url($input);
$host = strtolower((string)($parts['host'] ?? ''));
$path = (string)($parts['path'] ?? '');
if (($parts['scheme'] ?? '') !== 'https'
    || $host !== 'indianexpress.com'
    || isset($parts['user'])
    || isset($parts['pass'])
    || (isset($parts['port']) && (int)$parts['port'] !== 443)
    || !preg_match('~^/article/[a-zA-Z0-9/_-]+/?$~', $path)
    || strpos($path, '..') !== false) {
    reply(400, ['error' => 'Only Indian Express article URLs are supported']);
}

$articleUrl = 'https://indianexpress.com' . $path;
$dataFile = __DIR__ . '/../assets/data.js';
$knownData = is_file($dataFile) ? file_get_contents($dataFile) : false;
// Require the URL path to appear in the current Pheme edition before fetching it.
$knownPattern = '~"' . preg_quote($articleUrl, '~') . '(?:[?#"])~';
if (!is_string($knownData) || !preg_match($knownPattern, $knownData)) {
    reply(404, ['error' => 'This article is not in the current Pheme edition']);
}

$cacheDir = rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'pheme-indian-express-reader';
if (!is_dir($cacheDir)) {
    @mkdir($cacheDir, 0700, true);
}
$cacheFile = $cacheDir . DIRECTORY_SEPARATOR . hash('sha256', $articleUrl) . '.json';
if (is_file($cacheFile) && (time() - (int)filemtime($cacheFile)) < 900) {
    $cached = file_get_contents($cacheFile);
    if (is_string($cached)) {
        header('Cache-Control: private, max-age=300');
        echo $cached;
        exit;
    }
}

if (!function_exists('curl_init')) {
    reply(503, ['error' => 'The Pheme reader backend is unavailable']);
}

$maxBytes = 8 * 1024 * 1024;
$fetchUrl = $articleUrl;
$html = '';
$status = 0;
$contentType = '';
$fetchError = false;
$curlError = 0;
for ($redirect = 0; $redirect <= 3; $redirect++) {
    $responseBody = '';
    $location = '';
    $curl = curl_init($fetchUrl);
    curl_setopt_array($curl, [
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => 6,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_USERAGENT => 'Pheme source reader (+https://pheme24.online/)',
        CURLOPT_HTTPHEADER => ['Accept: text/html,application/xhtml+xml;q=0.9'],
        CURLOPT_HEADERFUNCTION => static function ($handle, string $line) use (&$location): int {
            if (stripos($line, 'Location:') === 0) {
                $location = trim(substr($line, 9));
            }
            return strlen($line);
        },
        CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$responseBody, $maxBytes): int {
            if (strlen($responseBody) + strlen($chunk) > $maxBytes) {
                return 0;
            }
            $responseBody .= $chunk;
            return strlen($chunk);
        },
    ]);
    $result = curl_exec($curl);
    $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $contentType = (string)curl_getinfo($curl, CURLINFO_CONTENT_TYPE);
    $curlError = (int)curl_errno($curl);
    curl_close($curl);

    if ($result === false) {
        $fetchError = true;
        break;
    }
    if ($status < 300 || $status >= 400) {
        $html = $responseBody;
        break;
    }
    if ($redirect === 3 || $location === '') {
        $fetchError = true;
        break;
    }

    // Resolve redirects ourselves and reject other hosts before making a request.
    if (preg_match('~^https://~i', $location)) {
        $nextUrl = $location;
    } elseif (strpos($location, '//') === 0) {
        $nextUrl = 'https:' . $location;
    } else {
        $current = parse_url($fetchUrl);
        if (strpos($location, '/') === 0) {
            $nextPath = $location;
        } elseif (strpos($location, '?') === 0) {
            $nextPath = (string)($current['path'] ?? '/') . $location;
        } else {
            $directory = dirname((string)($current['path'] ?? '/'));
            $nextPath = ($directory === '/' ? '' : $directory) . '/' . $location;
        }
        $segments = [];
        foreach (explode('/', (string)(parse_url($nextPath, PHP_URL_PATH) ?? '/')) as $segment) {
            if ($segment === '' || $segment === '.') {
                continue;
            }
            if ($segment === '..') {
                array_pop($segments);
                continue;
            }
            $segments[] = $segment;
        }
        $normalizedPath = '/' . implode('/', $segments);
        $query = parse_url($nextPath, PHP_URL_QUERY);
        $nextUrl = 'https://indianexpress.com' . $normalizedPath . ($query !== null ? '?' . $query : '');
    }

    $nextParts = parse_url($nextUrl);
    if (!is_array($nextParts)
        || strtolower((string)($nextParts['scheme'] ?? '')) !== 'https'
        || strtolower((string)($nextParts['host'] ?? '')) !== 'indianexpress.com'
        || isset($nextParts['user'])
        || isset($nextParts['pass'])
        || (isset($nextParts['port']) && (int)$nextParts['port'] !== 443)) {
        $fetchError = true;
        break;
    }
    $fetchUrl = $nextUrl;
}

if ($fetchError
    || $status < 200
    || $status >= 300
    || stripos($contentType, 'text/html') === false
    || strlen($html) === 0) {
    $failure = $fetchError ? 'fetch' : ($status < 200 || $status >= 300 ? 'upstream-status' : (stripos($contentType, 'text/html') === false ? 'content-type' : 'empty-page'));
    header('X-Pheme-Reader-Failure: ' . $failure);
    header('X-Pheme-Reader-Upstream-Status: ' . max(0, min(599, $status)));
    header('X-Pheme-Reader-Curl-Error: ' . max(0, min(999, $curlError)));
    reply(502, ['error' => 'Indian Express did not provide a public article page']);
}

$response = json_encode([
    'url' => $fetchUrl,
    'html' => $html,
], JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
if (!is_string($response)) {
    reply(502, ['error' => 'Could not prepare the article for Pheme']);
}

if (is_dir($cacheDir)) {
    @file_put_contents($cacheFile, $response, LOCK_EX);
}
header('Cache-Control: private, max-age=300');
echo $response;
