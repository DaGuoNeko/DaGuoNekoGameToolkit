.intel_syntax noprefix
.text
.global DgnBootstrap
DgnBootstrap:
 push rbx
 sub rsp, 32
 mov rbx, rcx
 xor ecx, ecx
 xor edx, edx
 lea r8, [rbx+56]
 lea r9, [rbx+72]
 call [rbx]
 test eax, eax
 js failed
 mov rax, [rbx+72]
 add rax, [rbx+48]
 xor ecx, ecx
 call rax
 test eax, eax
 jnz failed
 mov DWORD PTR [rbx+80], 1
 mov rcx, [rbx+40]
 xor edx, edx
 xor r8d, r8d
 call [rbx+8]
 test eax, eax
 jnz failed
 mov rcx, [rbx+32]
 mov rax, [rbx+24]
 add rsp, 32
 pop rbx
 jmp rax
failed:
 mov [rbx+80], eax
 mov ecx, eax
 call [rbx+16]
 int3
.global DgnBootstrapEnd
DgnBootstrapEnd:
