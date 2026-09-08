/** Compatibility starter used when neither a host seed nor local cache exists. */
export const DEFAULT_MAIN = `#include <iostream>

struct Node {
    int data;
    Node* next;
};

// Double every value in the list
void doubleValues(Node* head) {
    Node* current = head;
    while (current != nullptr) {
        current->data *= 2;
        current = current->next;
    }
}

int main() {
    // Build a linked list: 10 -> 20 -> 30
    Node* head = new Node{10, nullptr};
    head->next = new Node{20, nullptr};
    head->next->next = new Node{30, nullptr};

    // Print original values
    Node* current = head;
    while (current != nullptr) {
        std::cout << current->data << std::endl;
        current = current->next;
    }

    // Modify the list in a separate function (use "Step Into")
    doubleValues(head);

    // Print doubled values
    current = head;
    while (current != nullptr) {
        std::cout << current->data << std::endl;
        current = current->next;
    }

    // BUG: only free the head -- leak the rest!
    delete head;

    return 0;
}
`
