# Algo 1
I want you to implement this algorithm: basically, if I keep concatenating emails, it will eventually overflow. DO NOT IMPLEMENT ANY OTHER FUNCTION THAN THE ONES I GAVE YOU BELOW. COMMENT ON WHETHER IT IS OPTIMALLY EFFICIENT OR NOT BEFORE BEGINNING WORK.


```typescript
// ref-emails.ts

function getEmail(n: number) : string {
    // get the n-th email where 0-th is the oldest email and (N-1)-th, where N is the number of emails, is the latest email.
}

function getEmailSubstrings(i: number, j: number): string {
    const n = getNumberOfEmails();
    if (j > n) {
        j = n;
    }
    // get i-th email up to j-th email and concatenate it together. Feel free to change my impl.
    const s = "";
    for (let k = i; k < j; k++) {
        s += getEmail(k);
    }
    return s;
}

function getNumberOfEmails() {
    // implement
}
```


```typescript
// compact.ts

function getTokens(str: string) {
    // use anthropic sdk to get tokens.
}

function compact(strs: string[], targetNumberOfTokens: number) {
    const s = "";
    const i = 0;
    const j = 1;
    
    // sliding window approach:keep expanding j until getTokens(getEmailSubstrings(i, j)) > targetNumberOfTokens, then, set i = j and then repeat. Basically they'll be k numbers of concatenated emails just below the targetNumberOfTokens. Then we have k LLMs compact these k_0 concat emails in parallel. Then we concatenate those m \in{0, .., k_0} LLM compacted messages and perform the same sliding window approach so that there are k_1 LLM concated (k_0's which were compacted) and repeat until the final sliding window is under the targetNumberOfTokens. This is like a recursive function you see. Save each as `compacted/k_N/m.md` where N is the layer we're on and m is the m-th compacted message.
}

function main() {
    return compact(getEmailSubstrings(0, getNumberOfEmails()));
}
```