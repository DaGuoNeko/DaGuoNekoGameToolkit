// Process-local guest display name for the NetEase development client.
// No game file, saved option, account ID, or authentication check is changed.
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <stdint.h>

typedef struct { DWORD magic, version; WCHAR name[65]; } Request;
typedef struct { union { char small[16]; const char *large; } data; SIZE_T length, capacity; } GameString;
typedef void *(*StringCopy)(void *, const void *);
static BYTE *imageBase;
static DWORD imageSize;
static IMAGE_SECTION_HEADER sections[96];
static WORD sectionCount;
static char nameBytes[129];
static GameString nameValue;
static StringCopy copyString;
static LONG initialized;

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
static void *guestName(void *user,void *out) { return copyString(out,&nameValue); }

static DWORD install(void) {
    const BYTE type[]=".?AVUser_generic@Social@@";
    const BYTE log[]="ClientInstance::createPlayerAuthentication initialized with username %s";
    DWORD typeHits[8],logHits[8],refs[32];
    int n=findBytes(type,sizeof(type),IMAGE_SCN_CNT_INITIALIZED_DATA,typeHits,8,FALSE,0);
    if(n!=1 || typeHits[0]<16) return 20;
    DWORD typeRva=typeHits[0]-16;
    n=findBytes(log,sizeof(log),IMAGE_SCN_CNT_INITIALIZED_DATA,logHits,8,FALSE,0);
    if(n!=1)return 21;
    n=findBytes(NULL,7,IMAGE_SCN_CNT_CODE,refs,32,TRUE,logHits[0]);
    if(n<1)return 22;
    DWORD nameSlot=0;
    for(int r=0;r<n;r++) {
        BYTE before[128];if(refs[r]<128 || !readAt(refs[r]-128,before,sizeof(before)))return 22;
        const BYTE load[]={0x48,0x8b,0x08,0x48,0x8b,0x01};
        for(int i=0;i<100;i++) if(equal(before+i,load,sizeof(load))) {
            for(int j=i+6;j<i+22 && j+6<=128;j++) if(before[j]==0xff && before[j+1]==0x90) {
                DWORD slot=0;for(int k=0;k<4;k++)((BYTE*)&slot)[k]=before[j+2+k];
                if(slot<0x20 || slot>0x1000 || slot%8)return 22;
                if(nameSlot && nameSlot!=slot)return 22;nameSlot=slot;
            }
        }
    }
    if(!nameSlot)return 22;
    n=findBytes((BYTE*)&typeRva,4,IMAGE_SCN_CNT_INITIALIZED_DATA,refs,32,FALSE,0);
    if(n<1)return 23;
    DWORD colRva=0;
    for(int i=0;i<n;i++) {
        DWORD col[6];if(refs[i]<12 || !readAt(refs[i]-12,col,sizeof(col)))continue;
        if(col[0]==1 && col[1]==0 && col[2]==0 && col[3]==typeRva && col[5]==refs[i]-12) {
            if(colRva && colRva!=col[5])return 23;colRva=col[5];
        }
    }
    if(!colRva)return 23;
    uintptr_t col=(uintptr_t)(imageBase+colRva);
    n=findBytes((BYTE*)&col,8,IMAGE_SCN_CNT_INITIALIZED_DATA,refs,32,FALSE,0);
    if(n!=1)return 24;
    // The authentication log reads the optional sign-in identifier. Keep that
    // getter untouched; the preceding slot delegates to the guest identity's
    // display-name getter. Verify both implementations before replacing it.
    DWORD slotRva=refs[0]+8+nameSlot; void *function;
    if(!readAt(slotRva,&function,8) || (BYTE*)function<imageBase || (BYTE*)function-imageBase>=imageSize)return 24;
    DWORD fnRva=(DWORD)((BYTE*)function-imageBase);
    BYTE code[40];if(!executable(fnRva)||!readAt(fnRva,code,sizeof(code)))return 25;
    int skip=code[0]==0x40?1:0;
    const BYTE first[]={0x53,0x48,0x83,0xec,0x30,0x48,0x8b,0xda,0x48,0x8d,0x91};
    const BYTE second[]={0x48,0x8b,0xcb,0xe8};
    const BYTE last[]={0x48,0x8b,0xc3,0x48,0x83,0xc4,0x30,0x5b,0xc3};
    if(!equal(code+skip,first,sizeof(first)) || !equal(code+skip+15,second,sizeof(second)) ||
       !equal(code+skip+23,last,sizeof(last)))return 25;
    LONG relative;for(int i=0;i<4;i++)((BYTE*)&relative)[i]=code[skip+19+i];
    int64_t copyRva=(int64_t)fnRva+skip+23+relative;
    if(copyRva<0 || copyRva>=imageSize || !executable((DWORD)copyRva))return 25;
    copyString=(StringCopy)(imageBase+copyRva);
    slotRva-=8;
    if(!readAt(slotRva,&function,8)||(BYTE*)function<imageBase||(BYTE*)function-imageBase>=imageSize)return 25;
    DWORD displayRva=(DWORD)((BYTE*)function-imageBase);
    BYTE display[100];if(!executable(displayRva)||!readAt(displayRva,display,sizeof(display)))return 25;
    const BYTE identityCall[]={0xff,0x90,0xe0,0,0,0},displayCall[]={0xff,0x90,0xc8,0,0,0};
    BOOL hasIdentity=FALSE,hasDisplay=FALSE;
    for(int i=0;i<95;i++){if(equal(display+i,identityCall,6))hasIdentity=TRUE;if(equal(display+i,displayCall,6))hasDisplay=TRUE;}
    if(!hasIdentity||!hasDisplay)return 25;
    void **slot=(void**)(imageBase+slotRva);DWORD protection,unused;
    if(!VirtualProtect(slot,8,PAGE_READWRITE,&protection))return 26;
    void *previous=InterlockedCompareExchangePointer(slot,guestName,function);
    VirtualProtect(slot,8,protection,&unused);
    if(previous!=function)return 27;
    return 0;
}
__declspec(dllexport) DWORD WINAPI DgnInitialize(Request *request) {
    if(!request || request->magic!=0x44474e4e || request->version!=1 || request->name[64]!=0)return 1;
    if(InterlockedCompareExchange(&initialized,1,0)!=0)return 2;
    char encoded[129];int bytes=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,request->name,-1,encoded,sizeof(encoded),NULL,NULL);
    if(bytes<2 || bytes>129)return 3;
    for(int i=0;i<bytes;i++)nameBytes[i]=encoded[i];
    nameValue.length=bytes-1;nameValue.capacity=bytes<=16?15:128;
    if(bytes<=16)for(int i=0;i<bytes;i++)nameValue.data.small[i]=encoded[i];
    else nameValue.data.large=nameBytes;
    DWORD result=4;
    for(int i=0;i<80;i++) {
        if(loadImage()){result=install();if(result==0){InterlockedExchange(&initialized,2);return 0;}if(result>=25)return result;}
        Sleep(100);
    }
    return result;
}
BOOL WINAPI DllMainCRTStartup(HINSTANCE module,DWORD reason,LPVOID reserved){return TRUE;}
