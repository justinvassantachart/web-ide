struct Node {
    int value;
    Node* next;
};

int main() {
    Node* head = new Node{10, nullptr};
    head->next = new Node{20, nullptr};
    head->next->next = new Node{30, nullptr};
    Node* alias = head->next;
    Node* empty = nullptr;
    Node* delayed[101] = {};
    delayed[100] = head;
    int phase = 0;
    phase += 1; // GRAPH_LINKED
    head->next->next->next = head;
    phase += 1; // GRAPH_CYCLE
    head->next->next->next = nullptr;
    delete head->next->next;
    delete head->next;
    delete head;
    return phase + (alias == empty);
}
