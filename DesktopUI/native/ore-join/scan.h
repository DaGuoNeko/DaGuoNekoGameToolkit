static BYTE *imageBase;
static DWORD imageSize;
static IMAGE_SECTION_HEADER sections[96];
static WORD sectionCount;
static BOOL equal(const BYTE *a, const BYTE *b, SIZE_T length) {
    for (SIZE_T i=0; i<length; i++) if(a[i]!=b[i]) return FALSE;
    return TRUE;
}
static BOOL readAt(DWORD rva, void *out, SIZE_T size) {
    SIZE_T count=0;
    if(rva>imageSize || size>imageSize-rva) return FALSE;
    return ReadProcessMemory(GetCurrentProcess(),imageBase+rva,out,size,&count) && count==size;
}
static BOOL executable(DWORD rva) {
    for(WORD i=0;i<sectionCount;i++) if((sections[i].Characteristics&IMAGE_SCN_CNT_CODE) &&
        rva>=sections[i].VirtualAddress && rva-sections[i].VirtualAddress<sections[i].Misc.VirtualSize) return TRUE;
    return FALSE;
}
static BOOL loadImage(void) {
    IMAGE_DOS_HEADER dos; IMAGE_NT_HEADERS64 nt; SIZE_T count;
    imageBase=(BYTE*)GetModuleHandleW(NULL);
    if(!ReadProcessMemory(GetCurrentProcess(),imageBase,&dos,sizeof(dos),&count) || dos.e_magic!=IMAGE_DOS_SIGNATURE ||
       dos.e_lfanew<0 || dos.e_lfanew>1024*1024) return FALSE;
    if(!ReadProcessMemory(GetCurrentProcess(),imageBase+dos.e_lfanew,&nt,sizeof(nt),&count) ||
       nt.Signature!=IMAGE_NT_SIGNATURE || nt.FileHeader.Machine!=IMAGE_FILE_MACHINE_AMD64 ||
       nt.OptionalHeader.Magic!=IMAGE_NT_OPTIONAL_HDR64_MAGIC || nt.FileHeader.NumberOfSections>96) return FALSE;
    imageSize=nt.OptionalHeader.SizeOfImage; sectionCount=nt.FileHeader.NumberOfSections;
    if(imageSize<4096 || imageSize>1024*1024*1024) return FALSE;
    return readAt(dos.e_lfanew+24+nt.FileHeader.SizeOfOptionalHeader,sections,sectionCount*sizeof(sections[0]));
}
// Scan bounded, overlapping chunks. Uncommitted/protected pages are never dereferenced.
static int findBytes(const BYTE *pattern,DWORD length,DWORD flags,DWORD *hits,int capacity,BOOL ripReference,DWORD target) {
    const DWORD chunk=65536;
    BYTE *buffer=(BYTE*)HeapAlloc(GetProcessHeap(),0,chunk+512);
    if(!buffer) return -1;
    int found=0;
    for(WORD s=0;s<sectionCount;s++) {
        IMAGE_SECTION_HEADER *section=&sections[s];
        if(!(section->Characteristics&flags) || section->VirtualAddress>=imageSize) continue;
        DWORD size=section->Misc.VirtualSize;
        if(size>imageSize-section->VirtualAddress) {found=-1;break;}
        for(DWORD start=0;start<size;start+=chunk) {
            DWORD wanted=size-start; if(wanted>chunk+length-1) wanted=chunk+length-1;
            SIZE_T got=0;
            ReadProcessMemory(GetCurrentProcess(),imageBase+section->VirtualAddress+start,buffer,wanted,&got);
            for(DWORD i=0;i<chunk && i+length<=got;i++) {
                BOOL match;
                if(ripReference) {
                    BYTE mod=buffer[i+2]; LONG displacement;
                    match=(buffer[i]==0x48 || buffer[i]==0x4c) && buffer[i+1]==0x8d && (mod&0xc7)==5;
                    if(match) {for(int j=0;j<4;j++)((BYTE*)&displacement)[j]=buffer[i+3+j];
                        match=(int64_t)section->VirtualAddress+start+i+7+displacement==target;}
                } else match=equal(buffer+i,pattern,length);
                if(match) {if(found>=capacity){found=-1;goto done;}hits[found++]=section->VirtualAddress+start+i;}
            }
        }
    }
done: HeapFree(GetProcessHeap(),0,buffer);return found;
}
