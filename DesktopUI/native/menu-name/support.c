// Freestanding Windows entry points: no C/C++ runtime is linked into the game.
#include <stddef.h>
unsigned long _tls_index;
void *memset(void *target,int value,size_t size){volatile unsigned char *p=target;while(size--)*p++=(unsigned char)value;return target;}
void *memcpy(void *target,const void *source,size_t size){volatile unsigned char *d=target;const volatile unsigned char *s=source;while(size--)*d++=*s++;return target;}
int memcmp(const void *left,const void *right,size_t size){const unsigned char *a=left,*b=right;while(size--){if(*a!=*b)return *a-*b;a++;b++;}return 0;}
